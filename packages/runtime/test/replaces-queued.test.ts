import { describe, expect, it } from "vitest";
import { testAgent, text } from "./support.ts";

const make = { name: "bash", arguments: { command: "make" } };
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
      // Durable hands the model one steered input per boundary.
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
    const call = await agent.workspace.nextCall();

    await runtime.submit("reminder: stand-up", { requestId: "reminder:r1", whenBusy: "steer" });
    await runtime.submit("1 unread", notice(1));
    await runtime.submit("2 unread", notice(2));
    call.resolve(text("built"));
    await runtime.idle();

    agent.provider.assertComplete();
  });

  it("leaves a notice the model was already handed, so the model sees both", async () => {
    const agent = await testAgent();
    agent.provider
      .step("start", (request) => void request.call([make]))
      .step("second round", (request) => {
        expect(request.userTexts()).toEqual(["build it", "1 unread"]);
        request.call([{ name: "bash", arguments: { command: "make test" } }]);
      })
      .step("finish", (request) => {
        expect(request.userTexts(), "both notices").toEqual(["build it", "1 unread", "2 unread"]);
        request.text("done");
      });
    const { runtime } = await agent.open();
    await runtime.submit("build it", { requestId: "m1" });
    const build = await agent.workspace.nextCall();
    await runtime.submit("1 unread", notice(1));
    build.resolve(text("built"));
    const tests = await agent.workspace.nextCall();

    await runtime.submit("2 unread", notice(2));
    tests.resolve(text("passed"));
    await runtime.idle();

    agent.provider.assertComplete();
  });

  it("admits a notice once when it is submitted again after a crash", async () => {
    const agent = await testAgent();
    agent.provider.step(
      "start",
      (request) => void request.call([{ name: "read", arguments: { path: "MEMORY.md" } }]),
    );
    const first = await agent.open();
    await first.runtime.submit("recall", { requestId: "m1" });
    await agent.workspace.nextCall();
    await first.runtime.submit("1 unread", notice(1));
    // Dies before the connector stored its position, so the same notice comes again.
    first.database().freeze();

    agent.provider.step("after restart", (request) => {
      expect(request.userTexts(), "the notice, once").toEqual(["recall", "1 unread"]);
      request.text("recalled");
    });
    const second = await agent.open();
    // The read reruns and is still working, so the notice is still queued when it comes again.
    const rerun = await agent.workspace.nextCall();
    await second.runtime.submit("1 unread", notice(1));
    rerun.resolve(text("notes"));
    await second.runtime.idle();

    agent.provider.assertComplete();
  });
});
