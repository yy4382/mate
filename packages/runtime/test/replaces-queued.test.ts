import { describe, expect, it } from "vitest";
import { testAgent } from "./support.ts";

const make = { name: "run_action", arguments: { input: "make" } };
const notice = (id: number) => ({
  requestId: `notice:${id}`,
  whenBusy: "steer" as const,
  replaces: "notice:",
});

describe("replacing queued inputs", () => {
  it("withdraws an earlier notice the model was not handed yet, and keeps inputs of other kinds", async () => {
    const agent = await testAgent();
    agent.provider
      .step("start", (request) => void request.call([make]))
      .step("continue with the reminder", (request) => {
        expect(request.userTexts(), "the reminder stays").toEqual([
          "build it",
          "reminder: stand-up",
        ]);
        request.text("noted");
      })
      .step("continue with the notice", (request) => {
        expect(request.userTexts(), "only the newer notice").toEqual([
          "build it",
          "reminder: stand-up",
          "2 unread",
        ]);
        request.text("done");
      });
    const { runtime } = await agent.open();
    await runtime.submit("build it", { requestId: "m1" });
    const call = await agent.tools.nextCall();

    await runtime.submit("reminder: stand-up", { requestId: "reminder:r1", whenBusy: "steer" });
    await runtime.submit("1 unread", notice(1));
    await runtime.submit("2 unread", notice(2));
    call.resolve("built");
    await runtime.idle();

    agent.provider.assertComplete();
  });

  it("leaves a notice the model was already handed, so the model sees both", async () => {
    const agent = await testAgent();
    agent.provider
      .step("start", (request) => void request.call([make]))
      .step("second round", (request) => {
        expect(request.userTexts()).toEqual(["build it", "1 unread"]);
        request.call([{ name: "run_action", arguments: { input: "make test" } }]);
      })
      .step("finish", (request) => {
        expect(request.userTexts(), "both notices").toEqual(["build it", "1 unread", "2 unread"]);
        request.text("done");
      });
    const { runtime } = await agent.open();
    await runtime.submit("build it", { requestId: "m1" });
    const build = await agent.tools.nextCall();
    await runtime.submit("1 unread", notice(1));
    build.resolve("built");
    const tests = await agent.tools.nextCall();

    await runtime.submit("2 unread", notice(2));
    tests.resolve("passed");
    await runtime.idle();

    agent.provider.assertComplete();
  });

  it("admits a notice once when it is submitted again after a crash", async () => {
    const agent = await testAgent();
    agent.provider.step(
      "start",
      (request) => void request.call([{ name: "read_item", arguments: { key: "notes" } }]),
    );
    const first = await agent.open();
    await first.runtime.submit("recall", { requestId: "m1" });
    await agent.tools.nextCall();
    await first.runtime.submit("1 unread", notice(1));
    first.database().freeze();

    agent.provider.step("after restart", (request) => {
      expect(request.userTexts(), "the notice, once").toEqual(["recall", "1 unread"]);
      request.text("recalled");
    });
    const second = await agent.open();
    const rerun = await agent.tools.nextCall();
    await second.runtime.submit("1 unread", notice(1));
    rerun.resolve("notes");
    await second.runtime.idle();

    agent.provider.assertComplete();
  });
});
