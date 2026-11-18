import { describe, expect, it } from "vitest";
import { reminders } from "../src/reminders.ts";
import { FakeClock, defaultSettings, testAgent } from "./support.ts";

describe("reminders", () => {
  it("delivers a reminder that comes due while the Agent is idle", async () => {
    const clock = new FakeClock();
    const rem = reminders(clock);
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
    const { runtime } = await agent.open({
      extensions: [rem.extension],
      background: [rem.background],
    });
    await (await runtime.submit("set a reminder", { requestId: "m1" })).settled();

    clock.advance(5 * 60_000 + 1);
    await agent.provider.received(3);

    expect(reminderText).toContain("<reminder");
    expect(reminderText).toContain("check the build");
    await runtime.idle();
    agent.provider.assertComplete();
  });

  it("delivers an overdue reminder as soon as the Agent is reopened", async () => {
    const clock = new FakeClock();
    const firstRem = reminders(clock);
    const agent = await testAgent(defaultSettings, { clock });
    agent.provider
      .step("set", (request) => {
        request.call([
          { name: "reminder", arguments: { action: "set", note: "the overdue one", inMinutes: 1 } },
        ]);
      })
      .step("ack", (request) => request.text("set"));
    const first = await agent.open({
      extensions: [firstRem.extension],
      background: [firstRem.background],
    });
    await (await first.runtime.submit("set it", { requestId: "m1" })).settled();
    await first.runtime.close();

    clock.advance(2 * 60_000);

    let fired = false;
    agent.provider.step("fired", (request) => {
      fired = request.userTexts().some((text) => text.includes("the overdue one"));
      request.text("noted");
    });
    const secondRem = reminders(clock);
    const second = await agent.open({
      extensions: [secondRem.extension],
      background: [secondRem.background],
    });
    await agent.provider.received(3);

    expect(fired).toBe(true);
    await second.runtime.idle();
    agent.provider.assertComplete();
  });

  it("never delivers a reminder a second time after the process died before it was cleared", async () => {
    const clock = new FakeClock();
    const r1 = reminders(clock);
    const agent = await testAgent(defaultSettings, { clock });
    agent.provider
      .step("set", (request) => {
        request.call([
          { name: "reminder", arguments: { action: "set", note: "exactly once", inMinutes: 1 } },
        ]);
      })
      .step("ack", (request) => request.text("set"));
    const first = await agent.open({ extensions: [r1.extension], background: [r1.background] });
    await (await first.runtime.submit("set it", { requestId: "m1" })).settled();

    agent.provider.step("fired", (request) => {
      first.database().freeze();
      request.text("noted");
    });
    clock.advance(2 * 60_000);
    await agent.provider.received(3);

    agent.provider.step("resumed", (request) => {
      const reminderLines = request.userTexts().filter((text) => text.includes("exactly once"));
      expect(reminderLines).toHaveLength(1);
      request.text("done");
    });
    const r2 = reminders(clock);
    const second = await agent.open({ extensions: [r2.extension], background: [r2.background] });
    await second.runtime.idle();
    await second.runtime.close();
    const afterFirstReopen = agent.provider.requests.length;

    const r3 = reminders(clock);
    const third = await agent.open({ extensions: [r3.extension], background: [r3.background] });
    await third.runtime.idle();

    expect(agent.provider.requests).toHaveLength(afterFirstReopen);
    agent.provider.assertComplete();
  });

  it("never delivers a cancelled reminder", async () => {
    const clock = new FakeClock();
    const rem = reminders(clock);
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
    const { runtime } = await agent.open({
      extensions: [rem.extension],
      background: [rem.background],
    });
    await (await runtime.submit("set then cancel", { requestId: "m1" })).settled();

    clock.advance(15 * 60_000);
    await runtime.idle();

    expect(agent.provider.requests).toHaveLength(3);
    agent.provider.assertComplete();
  });

  it("rejects ISO timestamps without timezone offset", async () => {
    const clock = new FakeClock();
    const rem = reminders(clock);
    const agent = await testAgent(defaultSettings, { clock });
    let errOutput = "";
    agent.provider
      .step("bad ts", (request) => {
        request.call([
          {
            name: "reminder",
            arguments: { action: "set", note: "ambiguous", at: "2026-01-01T12:00:00" },
          },
        ]);
      })
      .step("ack", (request) => {
        errOutput = request.toolOutputs()[0] ?? "";
        request.text("sorry");
      });
    const { runtime } = await agent.open({
      extensions: [rem.extension],
      background: [rem.background],
    });
    await (await runtime.submit("remind", { requestId: "m1" })).settled();
    expect(errOutput).toContain("ISO 8601");
    agent.provider.assertComplete();
  });
});
