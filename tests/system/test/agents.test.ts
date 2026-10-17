import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chatSend, notices, output, readUnread, startSystem, until } from "./support.ts";

const numberAfter = (key: string, text: string): number => {
  const found = new RegExp(`"${key}":(\\d+)`).exec(text)?.[1];
  if (found === undefined) throw new Error(`no ${key} in ${text}`);
  return Number(found);
};

describe("Agents work together", () => {
  it("7. one Agent hands a task to another in a DM, the other claims and completes it, and the first is told", async () => {
    const system = await startSystem();
    const alice = await system.hire("alice", "Alice");
    const bob = await system.hire("bob", "Bob");
    const general = await system.channel("general", [alice.account]);
    const taskCreated = Promise.withResolvers<void>();
    let dm = 0;
    let taskId = 0;
    const calls: Record<string, string[]> = {};
    system.provider
      .lane("alice", (request) => request.userTexts().some((text) => text.includes("#general")))
      .step("notice", (request) => void (calls.read = request.call([readUnread(general)])))
      .step("open the DM", (request) => {
        expect(output(request, calls.read?.[0])).toContain("Please have Bob write the report.");
        calls.open = request.call([{ name: "chat_open_dm", arguments: { account: bob.account } }]);
      })
      .step("ask Bob", (request) => {
        dm = numberAfter("conversationId", output(request, calls.open?.[0]));
        calls.send = request.call([chatSend(dm, "Bob, please write the report.")]);
      })
      .step("create the task", (request) => {
        const messageId = numberAfter("messageId", output(request, calls.send?.[0]));
        calls.task = request.call([
          { name: "chat_create_task", arguments: { messageId, title: "Write the report" } },
        ]);
      })
      .step("wait", (request) => {
        expect(output(request, calls.task?.[0])).toContain("Write the report");
        taskCreated.resolve();
        request.text("handed over");
      })
      .step("Bob answered", (request) => {
        expect(notices(request).at(-1), "Alice is told Bob wrote").toContain("私信 @bob");
        calls.dm = request.call([readUnread(dm)]);
      })
      .step("tell the channel", (request) => {
        expect(output(request, calls.dm?.[0])).toContain("Report written.");
        calls.report = request.call([chatSend(general, "Bob finished the report.")]);
      })
      .step("done", (request) => request.text("done"));
    system.provider
      .lane("bob", (request) => request.userTexts().some((text) => text.includes("私信 @alice")))
      .step("notice", async (request) => {
        await taskCreated.promise;
        calls.bobRead = request.call([readUnread(dm)]);
      })
      .step("claim", (request) => {
        const read = output(request, calls.bobRead?.[0]);
        expect(read).toContain("Bob, please write the report.");
        taskId = numberAfter("taskId", read);
        calls.claim = request.call([
          { name: "chat_change_task", arguments: { taskId, change: { kind: "claim" } } },
        ]);
      })
      .step("work", (request) => {
        calls.work = request.call([
          { name: "bash", arguments: { command: "echo the report > report.txt" } },
        ]);
      })
      .step("complete", (request) => {
        calls.complete = request.call([
          { name: "chat_change_task", arguments: { taskId, change: { kind: "complete" } } },
        ]);
      })
      .step("answer", (request) => {
        calls.answer = request.call([chatSend(dm, "Report written.")]);
      })
      .step("done", (request) => request.text("done"));

    await system.post(general, "@alice Please have Bob write the report.", [alice.account]);

    await system.messageFrom(general, alice.account, "Bob finished the report.");
    await system.provider.received(14);
    system.provider.assertComplete();
    expect(readFileSync(join(bob.workspace, "report.txt"), "utf8"), "Bob did the work").toBe(
      "the report\n",
    );
    await until(async () => {
      const entries = await system.api<{ kind: string; change?: string }[]>(
        "GET",
        `/api/chat/history?conversation=${dm}`,
      );
      expect(
        entries.filter((entry) => entry.kind === "task").map((entry) => entry.change),
        "the DM shows the task created, claimed and completed",
      ).toEqual(["completed", "claimed", "created"]);
    });
  });

  it("8. an Agent has a work assistant run a command, and passes the assistant's report on to the channel", async () => {
    const system = await startSystem();
    const richard = await system.hire("richard", "Richard");
    const general = await system.channel("general", [richard.account]);
    const delegated = Promise.withResolvers<void>();
    const task = "Build the artifact: write artifact.txt and tell me what it says.";
    let read: string[] = [];
    let spawn: string[] = [];
    let sent: string[] = [];
    let work: string[] = [];
    system.provider
      .lane("worker", (request) => request.userTexts().some((text) => text.includes(task)))
      .step("work", async (request) => {
        await delegated.promise;
        work = request.call([
          { name: "bash", arguments: { command: "echo built > artifact.txt; cat artifact.txt" } },
        ]);
      })
      .step("answer", (request) => {
        expect(output(request, work[0]).trim()).toBe("built");
        request.text("artifact.txt says: built");
      });
    system.provider
      .step("notice", (request) => void (read = request.call([readUnread(general)])))
      .step("spawn", (request) => {
        expect(output(request, read[0])).toContain("Get the artifact built.");
        spawn = request.call([
          { name: "assistant", arguments: { action: "spawn", name: "worker", message: task } },
        ]);
      })
      .step("wait", (request) => {
        expect(output(request, spawn[0])).toContain("Started worker.");
        delegated.resolve();
        request.text("delegated");
      })
      .step("report", (request) => {
        expect(
          request.userTexts(),
          "the assistant's answer reaches the Agent as an input",
        ).toContainEqual("[assistant worker answered] artifact.txt says: built");
        sent = request.call([chatSend(general, "The worker built it: artifact.txt says built.")]);
      })
      .step("done", (request) => {
        expect(output(request, sent[0])).toContain('"status":"sent"');
        request.text("done");
      });

    await system.post(general, "@richard Get the artifact built.", [richard.account]);

    await system.messageFrom(
      general,
      richard.account,
      "The worker built it: artifact.txt says built.",
    );
    await system.provider.received(7);
    system.provider.assertComplete();
    expect(readFileSync(join(richard.workspace, "artifact.txt"), "utf8")).toBe("built\n");
  });
});
