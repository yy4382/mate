import type { ScriptedRequest } from "@mate/testkit";
import { describe, expect, it } from "vitest";
import { testChat } from "./test-chat.ts";
import { testAgent } from "./support.ts";

const spawn = (name: string, message: string) => ({
  name: "assistant",
  arguments: { action: "spawn", name, message },
});
const stop = (name: string) => ({ name: "assistant", arguments: { action: "stop", name } });
const status = () => ({ name: "assistant", arguments: { action: "status" } });

/** Claims the conversation whose first message is `message`: the assistant spawned with it. */
const openedWith = (message: string) => (request: { userTexts(): string[] }) =>
  request.userTexts()[0] === message;

const report = (name: string, answer: string) => `[assistant ${name} answered] ${answer}`;

/** How many times `needle` appears among a request's user messages. */
const mentions = (request: ScriptedRequest | undefined, needle: string) =>
  request?.userTexts().filter((value) => value.includes(needle)).length ?? 0;

describe("work assistants", () => {
  it("runs a spawned assistant in its own conversation and reports its answer to the primary conversation once", async () => {
    const agent = await testAgent();
    const finished = Promise.withResolvers<void>();
    agent.provider
      .step("primary spawns", (request) => void request.call([spawn("counter", "count the files")]))
      .step("primary acknowledges", (request) => {
        expect(request.toolOutputs().join(), "the spawn tool confirms the start").toContain(
          "Started counter",
        );
        request.text("Asked the assistant.");
      })
      .step("primary reads the report", (request) => {
        expect(mentions(request, report("counter", "There are 12 files.")), "one report").toBe(1);
        request.text("Noted.");
        finished.resolve();
      });
    const helper = agent.provider.lane("counter", openedWith("count the files"));
    helper.step("assistant works", (request) => {
      expect(request.systemTexts().join("\n"), "the assistant is told who it is").toContain(
        'work assistant "counter"',
      );
      expect(request.userTexts(), "the assistant sees only its own task").toEqual([
        "count the files",
      ]);
      request.text("There are 12 files.");
    });
    const { runtime } = await agent.open();

    await runtime.submit("count the files for me", { requestId: "m1" });
    await finished.promise;
    await runtime.idle();

    const keys = new Set(agent.provider.requests.map((request) => request.body.prompt_cache_key));
    expect(keys.size, "the assistant has a conversation of its own").toBe(2);
    agent.provider.assertComplete();
  });

  it("gives an assistant the workspace and history tools but not the assistant, reminder, or chat tools", async () => {
    const agent = await testAgent();
    const { port } = testChat();
    const finished = Promise.withResolvers<void>();
    let primaryTools: string[] = [];
    let assistantTools: string[] = [];
    agent.provider
      .step("primary spawns", (request) => {
        primaryTools = request.toolNames();
        request.call([spawn("worker", "look around")]);
      })
      .step("primary acknowledges", (request) => request.text("ok"))
      .step("primary reads the report", (request) => {
        request.text("noted");
        finished.resolve();
      });
    agent.provider.lane("worker", openedWith("look around")).step("assistant works", (request) => {
      assistantTools = request.toolNames();
      request.text("done");
    });
    const { runtime } = await agent.open({ chat: port });

    await runtime.submit("delegate it", { requestId: "m1" });
    await finished.promise;
    await runtime.idle();

    expect(primaryTools, "the primary conversation can delegate and set reminders").toEqual(
      expect.arrayContaining(["assistant", "reminder"]),
    );
    expect(assistantTools, "the assistant works in the Agent's workspace").toEqual(
      expect.arrayContaining(["bash", "read", "write", "edit"]),
    );
    for (const tools of [primaryTools, assistantTools])
      expect(tools, "both conversations look up their own earlier records").toEqual(
        expect.arrayContaining(["history_search", "history_read"]),
      );
    expect(assistantTools, "the assistant cannot delegate").not.toContain("assistant");
    expect(assistantTools, "the assistant cannot set reminders").not.toContain("reminder");
    expect(primaryTools, "the primary conversation can chat").toContain("chat_send");
    expect(
      assistantTools.filter((name) => name.startsWith("chat_")),
      "the assistant has no chat tools",
    ).toEqual([]);
    agent.provider.assertComplete();
  });

  it("reports an assistant's answer exactly once when the process dies while the assistant is working", async () => {
    const agent = await testAgent();
    const helper = agent.provider.lane("once", openedWith("work it out"));
    const first = await agent.open();
    agent.provider
      .step("primary spawns", (request) => void request.call([spawn("once", "work it out")]))
      .step("primary acknowledges as the process dies", async (request) => {
        // Both conversations have a request open, so the spawn is committed and the assistant is working.
        await helper.received(1);
        first.database().freeze();
        void request.hang();
      });
    helper.step("assistant is working as the process dies", (request) => void request.hang());
    await first.runtime.submit("delegate it", { requestId: "m1" });
    await agent.provider.received(3);
    // A dead process drops its open requests.
    await first.runtime.close().catch(() => undefined);

    const finished = Promise.withResolvers<void>();
    agent.provider
      .step("primary acknowledges after the restart", (request) => request.text("started"))
      .step("primary reads the report", (request) => {
        request.text("noted");
        finished.resolve();
      });
    helper.step("assistant answers after the restart", (request) => {
      expect(request.userTexts(), "the assistant got its message once").toEqual(["work it out"]);
      request.text("done");
    });
    const second = await agent.open();
    await finished.promise;
    await second.runtime.idle();

    const primary = agent.provider.requests.filter((request) => request.lane === "default");
    expect(mentions(primary.at(-1), report("once", "done")), "the report is not lost").toBe(1);
    agent.provider.assertComplete();
  });

  it("reports an assistant's answer exactly once when the process dies while the primary conversation reads it", async () => {
    const agent = await testAgent();
    const first = await agent.open();
    agent.provider
      .step("primary spawns", (request) => void request.call([spawn("once", "work it out")]))
      .step("primary acknowledges", (request) => request.text("started"))
      .step("primary reads the report as the process dies", (request) => {
        first.database().freeze();
        void request.hang();
      });
    agent.provider
      .lane("once", openedWith("work it out"))
      .step("assistant answers", (request) => request.text("done"));
    await first.runtime.submit("delegate it", { requestId: "m1" });
    await agent.provider.received(4);
    // A dead process drops its open requests.
    await first.runtime.close().catch(() => undefined);

    const finished = Promise.withResolvers<void>();
    agent.provider.step("primary reads the report after the restart", (request) => {
      expect(mentions(request, report("once", "done")), "the report is placed once").toBe(1);
      request.text("noted");
      finished.resolve();
    });
    const second = await agent.open();
    await finished.promise;
    await second.runtime.idle();

    agent.provider.assertComplete();
  });

  it("does not create a second assistant when a spawn is repeated after a crash", async () => {
    const agent = await testAgent();
    const helper = agent.provider.lane("counter", openedWith("count the files"));
    const first = await agent.open();
    agent.provider
      .step("primary spawns", (request) => void request.call([spawn("counter", "count the files")]))
      .step("primary acknowledges as the process dies", async (request) => {
        await helper.received(1);
        first.database().freeze();
        void request.hang();
      });
    helper.step("assistant is working as the process dies", (request) => void request.hang());
    await first.runtime.submit("count the files for me", { requestId: "m1" });
    await agent.provider.received(3);
    // A dead process drops its open requests.
    await first.runtime.close().catch(() => undefined);

    const finished = Promise.withResolvers<void>();
    let retry: string[] = [];
    let check: string[] = [];
    agent.provider
      .step("primary spawns the same assistant again", (request) => {
        retry = request.call([spawn("counter", "count the files")]);
      })
      .step("primary asks for the status", (request) => {
        expect(request.toolOutput(retry[0] ?? ""), "the repeated spawn is refused").toMatch(
          /already exists/,
        );
        check = request.call([status()]);
      })
      .step("primary reads the status", (request) => {
        const lines = (request.toolOutput(check[0] ?? "") ?? "").split("\n");
        expect(lines, "there is exactly one assistant").toHaveLength(1);
        expect(lines[0]).toMatch(/^counter: /);
        request.text("one assistant");
      })
      .step("primary reads the report", (request) => {
        request.text("noted");
        finished.resolve();
      });
    helper.step("assistant answers after the restart", (request) => request.text("12 files"));
    const second = await agent.open();
    await finished.promise;
    await second.runtime.idle();

    const keys = new Set(agent.provider.requests.map((request) => request.body.prompt_cache_key));
    expect(keys.size, "only one assistant conversation ever asked the model").toBe(2);
    agent.provider.assertComplete();
  });

  it("stops one assistant without stopping another or the primary conversation", async () => {
    const agent = await testAgent();
    const finished = Promise.withResolvers<void>();
    const slow = agent.provider.lane("slow", openedWith("long job"));
    const quick = agent.provider.lane("quick", openedWith("short job"));
    const slowCancelled = Promise.withResolvers<void>();
    let stopped: string[] = [];
    agent.provider
      .step(
        "primary spawns two",
        (request) => void request.call([spawn("slow", "long job"), spawn("quick", "short job")]),
      )
      .step("primary stops the slow one", async (request) => {
        await slow.received(1);
        stopped = request.call([stop("slow")]);
      })
      .step("primary continues after the stop", (request) => {
        expect(request.toolOutput(stopped[0] ?? "")).toContain("Stopped slow");
        request.text("stopped slow");
      })
      .step("primary reads the quick one's report", (request) => {
        expect(mentions(request, report("quick", "quick done"))).toBe(1);
        expect(mentions(request, "[assistant slow"), "the stopped one reports nothing").toBe(0);
        request.text("ok");
        finished.resolve();
      });
    slow.step(
      "slow works until stopped",
      (request) => void request.hang().then(slowCancelled.resolve),
    );
    quick.step("quick works", async (request) => {
      // Answer only once the slow one was stopped, so the stop happens while both are alive.
      await slowCancelled.promise;
      request.text("quick done");
    });
    const { runtime } = await agent.open();

    await runtime.submit("start both", { requestId: "m1" });
    await slowCancelled.promise;
    await finished.promise;
    await runtime.idle();

    agent.provider.assertComplete();
  });

  it("stops the primary conversation and its assistants on close, and each continues its own context on reopen", async () => {
    const agent = await testAgent();
    const helper = agent.provider.lane("counter", openedWith("count the files"));
    const cancelled: Promise<void>[] = [];
    agent.provider
      .step("primary spawns", (request) => void request.call([spawn("counter", "count the files")]))
      .step("primary is thinking at close", (request) => void cancelled.push(request.hang()));
    helper.step("assistant is working at close", (request) => void cancelled.push(request.hang()));
    const first = await agent.open();
    await first.runtime.submit("count the files for me", { requestId: "m1" });
    await agent.provider.received(3);

    await first.runtime.close();
    await Promise.all(cancelled);

    const [primaryBefore, assistantBefore] = [
      agent.provider.requests.filter((request) => request.lane === "default").at(-1),
      helper.requests.at(-1),
    ];
    const finished = Promise.withResolvers<void>();
    agent.provider
      .step("primary resumes", (request) => {
        expect(request.body.prompt_cache_key).toBe(primaryBefore?.body.prompt_cache_key);
        expect(request.body.input, "the primary context continues").toEqual(
          primaryBefore?.body.input,
        );
        request.text("asked");
      })
      .step("primary reads the report", (request) => {
        expect(mentions(request, report("counter", "12 files"))).toBe(1);
        request.text("noted");
        finished.resolve();
      });
    helper.step("assistant resumes", (request) => {
      expect(request.body.prompt_cache_key).toBe(assistantBefore?.body.prompt_cache_key);
      expect(request.body.input, "the assistant context continues").toEqual(
        assistantBefore?.body.input,
      );
      request.text("12 files");
    });
    const second = await agent.open();
    await finished.promise;
    await second.runtime.idle();

    agent.provider.assertComplete();
  });
});
