import { describe, expect, it } from "vitest";
import { said, saidNow, testAgent, text, update } from "./support.ts";

const make = { name: "bash", arguments: { command: "make" } };

describe("a kind that replaces its queued inputs", () => {
  it("withdraws an earlier update the model was not handed yet, and keeps inputs of other kinds", async () => {
    const agent = await testAgent();
    agent.provider
      .step("start", (request) => void request.call([make]))
      // Durable hands the model one steered input per boundary.
      .step("continue with the other kind", (request) => {
        expect(request.userTexts(), "the other kind stays").toEqual(["build it", "stand-up"]);
        request.text("noted");
      })
      .step("continue with the update", (request) => {
        expect(request.userTexts(), "only the newer update").toEqual([
          "build it",
          "stand-up",
          "2 unread",
        ]);
        request.text("done");
      });
    const { runtime } = await agent.open();
    await runtime.submit(said.input("m1", "build it"));
    const call = await agent.workspace.nextCall();

    await runtime.submit(saidNow.input("r1", "stand-up"));
    await runtime.submit(update.input("1", "1 unread"));
    await runtime.submit(update.input("2", "2 unread"));
    call.resolve(text("built"));
    await runtime.idle();

    agent.provider.assertComplete();
  });

  it("leaves an update the model was already handed, so the model sees both", async () => {
    const agent = await testAgent();
    agent.provider
      .step("start", (request) => void request.call([make]))
      .step("second round", (request) => {
        expect(request.userTexts()).toEqual(["build it", "1 unread"]);
        request.call([{ name: "bash", arguments: { command: "make test" } }]);
      })
      .step("finish", (request) => {
        expect(request.userTexts(), "both updates").toEqual(["build it", "1 unread", "2 unread"]);
        request.text("done");
      });
    const { runtime } = await agent.open();
    await runtime.submit(said.input("m1", "build it"));
    const build = await agent.workspace.nextCall();
    await runtime.submit(update.input("1", "1 unread"));
    build.resolve(text("built"));
    const tests = await agent.workspace.nextCall();

    await runtime.submit(update.input("2", "2 unread"));
    tests.resolve(text("passed"));
    await runtime.idle();

    agent.provider.assertComplete();
  });

  it("admits an update once when it is submitted again after a crash", async () => {
    const agent = await testAgent();
    agent.provider.step(
      "start",
      (request) => void request.call([{ name: "read", arguments: { path: "MEMORY.md" } }]),
    );
    const first = await agent.open();
    await first.runtime.submit(said.input("m1", "recall"));
    await agent.workspace.nextCall();
    await first.runtime.submit(update.input("1", "1 unread"));
    // Dies before its producer stored its position, so the same update comes again.
    first.database().freeze();

    agent.provider.step("after restart", (request) => {
      expect(request.userTexts(), "the update, once").toEqual(["recall", "1 unread"]);
      request.text("recalled");
    });
    const second = await agent.open();
    // The read reruns and is still working, so the update is still queued when it comes again.
    const rerun = await agent.workspace.nextCall();
    await second.runtime.submit(update.input("1", "1 unread"));
    rerun.resolve(text("notes"));
    await second.runtime.idle();

    agent.provider.assertComplete();
  });
});
