import { FakeClock } from "@mate/testkit";
import { describe, expect, it } from "vitest";
import { defaultSettings, testAgent } from "./support.ts";

describe("reminders", () => {
  it("delivers a reminder that comes due while the Agent is idle", async () => {
    const clock = new FakeClock();
    const agent = await testAgent(defaultSettings, { clock });
    let reminderText: string | undefined;
    agent.provider
      .step("set", (request) => {
        request.call([
          { name: "reminder", arguments: { action: "set", note: "check the build", inMinutes: 5 } },
        ]);
      })
      .step("ack", (request) => request.text("reminder set"))
      .step("fired", (request) => {
        reminderText = request.userTexts().find((text) => text.includes("check the build"));
        request.text("noted");
      });
    const { runtime } = await agent.open();
    await (await runtime.submit("set a reminder", { requestId: "m1" })).settled();

    clock.advance(5 * 60_000 + 1);
    await agent.provider.received(3);

    expect(reminderText).toMatch(/check the build/);
    await runtime.idle();
    agent.provider.assertComplete();
  });

  it("delivers an overdue reminder as soon as the Agent is reopened", async () => {
    const clock = new FakeClock();
    const agent = await testAgent(defaultSettings, { clock });
    agent.provider
      .step("set", (request) => {
        request.call([
          { name: "reminder", arguments: { action: "set", note: "the overdue one", inMinutes: 1 } },
        ]);
      })
      .step("ack", (request) => request.text("set"));
    const first = await agent.open();
    await (await first.runtime.submit("set it", { requestId: "m1" })).settled();
    await first.runtime.close();

    clock.advance(2 * 60_000);

    let fired = false;
    agent.provider.step("fired", (request) => {
      fired = request.userTexts().some((text) => text.includes("the overdue one"));
      request.text("noted");
    });
    const second = await agent.open();
    await agent.provider.received(3);

    expect(fired).toBe(true);
    await second.runtime.idle();
    agent.provider.assertComplete();
  });

  it("never delivers a reminder a second time after the process died before it was cleared", async () => {
    const clock = new FakeClock();
    const agent = await testAgent(defaultSettings, { clock });
    agent.provider
      .step("set", (request) => {
        request.call([
          { name: "reminder", arguments: { action: "set", note: "exactly once", inMinutes: 1 } },
        ]);
      })
      .step("ack", (request) => request.text("set"));
    const first = await agent.open();
    await (await first.runtime.submit("set it", { requestId: "m1" })).settled();

    // The reminder fires, and the process dies before it can clear the reminder from its own store.
    agent.provider.step("fired", (request) => {
      first.database().freeze();
      request.text("noted");
    });
    clock.advance(2 * 60_000);
    await agent.provider.received(3);

    // Reopening resumes the interrupted answer. The reminder must not be delivered again.
    agent.provider.step("resumed", (request) => {
      const reminderLines = request.userTexts().filter((text) => text.includes("exactly once"));
      expect(reminderLines).toHaveLength(1);
      request.text("done");
    });
    const second = await agent.open();
    await second.runtime.idle();
    await second.runtime.close();
    const afterFirstReopen = agent.provider.requests.length;

    const third = await agent.open();
    await third.runtime.idle();

    expect(agent.provider.requests).toHaveLength(afterFirstReopen);
    agent.provider.assertComplete();
  });

  it("never delivers a cancelled reminder", async () => {
    const clock = new FakeClock();
    const agent = await testAgent(defaultSettings, { clock });
    agent.provider
      .step("set", (request) => {
        request.call([
          { name: "reminder", arguments: { action: "set", note: "cancel me", inMinutes: 10 } },
        ]);
      })
      .step("cancel", (request) => {
        const id =
          request
            .toolOutputs()
            .join()
            .match(/Set (r\d+)/)?.[1] ?? "";
        request.call([{ name: "reminder", arguments: { action: "cancel", id } }]);
      })
      .step("ack", (request) => request.text("cancelled"));
    const { runtime } = await agent.open();
    await (await runtime.submit("set then cancel", { requestId: "m1" })).settled();

    clock.advance(15 * 60_000);
    await runtime.idle();

    expect(agent.provider.requests).toHaveLength(3);
    agent.provider.assertComplete();
  });

  it("delivers a reminder that comes due mid-run as a steer, without starting a second run", async () => {
    const clock = new FakeClock();
    const agent = await testAgent(defaultSettings, { clock });
    agent.provider
      .step("set and work", (request) => {
        request.call([
          { name: "reminder", arguments: { action: "set", note: "while busy", inMinutes: 1 } },
          { name: "bash", arguments: { command: "build" } },
        ]);
      })
      .step("continued", (request) => {
        expect(request.userTexts()).toEqual([
          "set the reminder while I work",
          expect.stringContaining("while busy"),
        ]);
        request.text("done");
      });
    const { runtime } = await agent.open();
    const input = await runtime.submit("set the reminder while I work", { requestId: "m1" });

    // The reminder is set in process; the command is the only call that reaches the workspace.
    const command = await agent.workspace.nextCall();
    expect(command.request.tool).toBe("bash");
    clock.advance(60_000 + 1);
    // Let the reminder loop finish submitting its input, so the command is still the running tool round.
    await new Promise((resolve) => setTimeout(resolve, 100));
    command.resolve({ content: [{ type: "text", text: "built" }], isError: false });

    expect(await input.settled()).toBe("done");
    await runtime.idle();
    expect(agent.provider.requests).toHaveLength(2);
    agent.provider.assertComplete();
  });
});
