import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  chatSend,
  longCommand,
  notices,
  output,
  processGone,
  readUnread,
  startSystem,
} from "./support.ts";

const pidIn = (workspace: string) => Number(readFileSync(join(workspace, "pid"), "utf8"));

describe("the system survives losing a part of itself", { timeout: 60_000 }, () => {
  it("4. a command running when the control plane is killed is not run again, the Agent is told it was interrupted, and it carries on", async () => {
    const system = await startSystem();
    const richard = await system.hire("richard", "Richard");
    const general = await system.channel("general", [richard.account]);
    let command: string[] = [];
    let check: string[] = [];
    let sent: string[] = [];
    system.provider
      .step("notice", (request) => void request.call([readUnread(general)]))
      .step("start the long command", (request) => {
        command = request.call([{ name: "bash", arguments: { command: longCommand() } }]);
      })
      .step("after the restart", async (request) => {
        expect(
          output(request, command[0]),
          "the Agent is told the command was interrupted",
        ).toMatch(/interrupt/i);
        await system.nodeOnline();
        check = request.call([{ name: "bash", arguments: { command: "cat runs.log" } }]);
      })
      .step("report", (request) => {
        expect(output(request, check[0]).trim(), "the command ran once").toBe("run");
        sent = request.call([chatSend(general, "The command was interrupted; it ran once.")]);
      })
      .step("done", (request) => {
        expect(output(request, sent[0])).toContain('"status":"sent"');
        request.text("done");
      });

    await system.post(general, "@richard Run the long job.", [richard.account]);
    await system.fileExists(join(richard.workspace, "started"));
    await system.plane.kill();
    await system.plane.start();

    await system.messageFrom(general, richard.account, "The command was interrupted; it ran once.");
    await processGone(pidIn(richard.workspace));
    await system.provider.received(5);
    system.provider.assertComplete();
  });

  it("5. a command running when the node's network is cut ends as unknown, the Agent keeps working in chat, and the node's next command runs once the network is back", async () => {
    const system = await startSystem({ proxied: true });
    const proxy = system.proxy;
    if (proxy === undefined) throw new Error("the system has no proxy");
    const richard = await system.hire("richard", "Richard");
    const general = await system.channel("general", [richard.account]);
    let command: string[] = [];
    let lost: string[] = [];
    let again: string[] = [];
    let fresh: string[] = [];
    let sent: string[] = [];
    system.provider
      .step("notice", (request) => void request.call([readUnread(general)]))
      .step("start the long command", (request) => {
        command = request.call([{ name: "bash", arguments: { command: longCommand() } }]);
      })
      .step("after the cut", (request) => {
        expect(output(request, command[0]), "the result is unknown").toMatch(/unknown/i);
        lost = request.call([chatSend(general, "I lost the node.")]);
      })
      .step("wait for the node", (request) => {
        expect(output(request, lost[0])).toContain('"status":"sent"');
        request.text("waiting for the node");
      })
      .step("second notice", (request) => void (again = request.call([readUnread(general)])))
      .step("run on the restored node", (request) => {
        expect(output(request, again[0])).toContain("Try again.");
        fresh = request.call([{ name: "bash", arguments: { command: "echo hello" } }]);
      })
      .step("report", (request) => {
        expect(output(request, fresh[0]).trim()).toBe("hello");
        sent = request.call([chatSend(general, "The node is back.")]);
      })
      .step("done", (request) => {
        expect(output(request, sent[0])).toContain('"status":"sent"');
        request.text("done");
      });

    await system.post(general, "@richard Run the long job.", [richard.account]);
    await system.fileExists(join(richard.workspace, "started"));
    proxy.setMode("disconnect");
    await system.messageFrom(general, richard.account, "I lost the node.");
    await processGone(pidIn(richard.workspace));

    proxy.setMode("forward");
    await system.nodeOnline();
    await system.post(general, "@richard Try again.", [richard.account]);
    await system.messageFrom(general, richard.account, "The node is back.");
    await system.provider.received(8);
    system.provider.assertComplete();
  });

  it("6. a paused Agent makes no model call and its command is stopped, and when resumed it handles what piled up", async () => {
    const system = await startSystem();
    const richard = await system.hire("richard", "Richard");
    const general = await system.channel("general", [richard.account]);
    let resumeRequested = false;
    const resumed = Promise.withResolvers<void>();
    let command: string[] = [];
    let read: string[] = [];
    let sent: string[] = [];
    system.provider
      .step("notice", (request) => void request.call([readUnread(general)]))
      .step("start the long command", (request) => {
        command = request.call([{ name: "bash", arguments: { command: longCommand() } }]);
      })
      .step("after the resume", async (request) => {
        expect(resumeRequested, "no model call happened while the Agent was paused").toBe(true);
        expect(output(request, command[0]), "the command did not complete").toMatch(
          /interrupt|stopped|not retried/i,
        );
        await resumed.promise;
        read = request.call([readUnread(general)]);
      })
      .step("handle the backlog", (request) => {
        expect(notices(request), "the first notice and one for the backlog").toHaveLength(2);
        expect(output(request, read[0])).toContain("While you were paused, the build broke.");
        sent = request.call([chatSend(general, "Back. Looking at the build.")]);
      })
      .step("done", (request) => {
        expect(output(request, sent[0])).toContain('"status":"sent"');
        request.text("done");
      });

    await system.post(general, "@richard Run the long job.", [richard.account]);
    await system.fileExists(join(richard.workspace, "started"));
    await system.api("POST", `/api/admin/agents/${richard.agentId}/pause`, undefined, 204);
    await processGone(pidIn(richard.workspace));
    await system.post(general, "While you were paused, the build broke.", [richard.account]);
    expect(system.provider.requests, "the pause stopped the model").toHaveLength(2);

    resumeRequested = true;
    await system.api("POST", `/api/admin/agents/${richard.agentId}/resume`, undefined, 204);
    resumed.resolve();

    await system.messageFrom(general, richard.account, "Back. Looking at the build.");
    await system.provider.received(5);
    system.provider.assertComplete();
  });
});
