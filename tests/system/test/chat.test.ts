import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ServerEvent } from "@mate/testkit";
import {
  chatSend,
  longCommand,
  notices,
  output,
  readUnread,
  startSystem,
  until,
} from "./support.ts";

describe("the owner talks to an Agent in a channel", () => {
  it("1. an Agent mentioned in a channel reads it and replies", async () => {
    const system = await startSystem();
    const richard = await system.hire("richard", "Richard");
    const general = await system.channel("general", [richard.account]);
    let read: string[] = [];
    let sent: string[] = [];
    system.provider
      .step("notice", (request) => {
        expect(notices(request), "one notice").toHaveLength(1);
        expect(notices(request)[0], "it says the Agent was mentioned in #general").toContain(
          `@了你`,
        );
        read = request.call([readUnread(general)]);
      })
      .step("reply", (request) => {
        expect(output(request, read[0]), "the Agent reads the owner's message").toContain(
          "Can you check the build?",
        );
        sent = request.call([chatSend(general, "The build is green.")]);
      })
      .step("done", (request) => {
        expect(output(request, sent[0])).toContain('"status":"sent"');
        request.text("replied");
      });

    await system.post(general, "@richard Can you check the build?", [richard.account]);

    await system.messageFrom(general, richard.account, "The build is green.");
    await system.provider.received(3);
    system.provider.assertComplete();
  });

  it("2. messages sent while an Agent runs a long command reach it as one notice, and it reads both after the command", async () => {
    const system = await startSystem();
    const richard = await system.hire("richard", "Richard");
    const general = await system.channel("general", [richard.account]);
    let first: string[] = [];
    let command: string[] = [];
    let second: string[] = [];
    let sent: string[] = [];
    system.provider
      .step("notice", (request) => {
        first = request.call([readUnread(general)]);
      })
      .step("start the long command", (request) => {
        expect(output(request, first[0])).toContain("Start the migration.");
        command = request.call([{ name: "bash", arguments: { command: longCommand() } }]);
      })
      .step("notice of the later messages", (request) => {
        expect(output(request, command[0]), "the command ran to its end").toContain("finished");
        const all = notices(request);
        expect(all, "the first notice and one for both later messages").toHaveLength(2);
        expect(all[1], "the one notice counts both messages").toContain("至少 2 条");
        second = request.call([readUnread(general)]);
      })
      .step("reply", (request) => {
        const read = output(request, second[0]);
        expect(read).toContain("Use the staging database.");
        expect(read).toContain("And skip the audit table.");
        sent = request.call([chatSend(general, "Migrated on staging, audit table skipped.")]);
      })
      .step("done", (request) => {
        expect(output(request, sent[0])).toContain('"status":"sent"');
        request.text("replied");
      });

    const events = await system.owner.stream(`/api/admin/agents/${richard.agentId}/events`);
    const queuedIds = (event: ServerEvent): string[] =>
      (event.data as { type: string; items?: { id: string }[] }[])
        .filter((each) => each.type === "inbox_update" && each.items?.length === 1)
        .map((each) => each.items?.[0]?.id ?? "");

    await system.post(general, "@richard Start the migration.", [richard.account]);
    await system.fileExists(join(richard.workspace, "started"));
    const afterStart = events.events.length;
    await system.post(general, "Use the staging database.");
    const firstNotice = queuedIds(
      await events.next((event) => queuedIds(event).length > 0, afterStart),
    )[0];
    await system.post(general, "And skip the audit table.");
    await events.next((event) => queuedIds(event).some((id) => id !== firstNotice), afterStart);
    system.release(richard.workspace);

    await system.messageFrom(general, richard.account, "Migrated on staging, audit table skipped.");
    await system.provider.received(5);
    system.provider.assertComplete();
  });

  it("3. a send held because the owner wrote after the Agent's read is resent revised and reaches the channel once", async () => {
    const system = await startSystem();
    const richard = await system.hire("richard", "Richard");
    const general = await system.channel("general", [richard.account]);
    let held: string[] = [];
    let resent: string[] = [];
    system.provider
      .step("notice", (request) => void request.call([readUnread(general)]))
      .step("send while the owner writes", async (request) => {
        await system.post(general, "Wait, use staging.");
        held = request.call([chatSend(general, "Deploying to prod.")]);
      })
      .step("resend", (request) => {
        const result = output(request, held[0]);
        expect(result, "the send was held").toContain('"status":"held"');
        expect(result, "with what the Agent missed").toContain("Wait, use staging.");
        resent = request.call([chatSend(general, "Deploying to staging.")]);
      })
      .step("done", (request) => {
        expect(output(request, resent[0])).toContain('"status":"sent"');
        request.text("done");
      });

    await system.post(general, "Please deploy, @richard.", [richard.account]);

    await system.messageFrom(general, richard.account, "Deploying to staging.");
    await until(async () => {
      expect((await system.messages(general)).map((message) => message.body)).toEqual([
        "Please deploy, @richard.",
        "Wait, use staging.",
        "Deploying to staging.",
      ]);
    });
    await system.provider.received(4);
    system.provider.assertComplete();
  });
});
