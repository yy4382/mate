import { expect, it, vi } from "vitest";
import {
  completeManagedStartup,
  notifyServiceReady,
  type ReadinessRunner,
} from "../../src/deployment/readiness.js";

it("does nothing outside a systemd notify service", () => {
  const run = vi.fn<ReadinessRunner>();
  notifyServiceReady({}, run);
  expect(run).not.toHaveBeenCalled();
});

it("publishes readiness only through the fixed systemd notifier", () => {
  const environment = {
    NOTIFY_SOCKET: "/run/systemd/notify",
    MODEL_API_KEY: "secret",
  };
  const run = vi.fn<ReadinessRunner>().mockReturnValue({ code: 0, stderr: "" });
  notifyServiceReady(environment, run);
  expect(run).toHaveBeenCalledWith("/usr/bin/systemd-notify", ["--ready"], environment);
});

it("fails startup when the service manager cannot record readiness", () => {
  const run: ReadinessRunner = () => ({ code: 1, stderr: "private detail" });
  expect(() => notifyServiceReady({ NOTIFY_SOCKET: "/run/systemd/notify" }, run)).toThrow(
    "Cannot notify the service manager",
  );
});

it("never reports ready before managed startup completes or after it fails", async () => {
  const events: string[] = [],
    run: ReadinessRunner = () => {
      events.push("ready");
      return { code: 0, stderr: "" };
    };
  await completeManagedStartup(
    async () => {
      events.push("start");
      await Promise.resolve();
      events.push("started");
    },
    { NOTIFY_SOCKET: "/run/systemd/notify" },
    run,
  );
  expect(events).toEqual(["start", "started", "ready"]);
  events.length = 0;
  await expect(
    completeManagedStartup(
      async () => {
        events.push("start");
        throw new Error("probe failed");
      },
      { NOTIFY_SOCKET: "/run/systemd/notify" },
      run,
    ),
  ).rejects.toThrow("probe failed");
  expect(events).toEqual(["start"]);
  await expect(
    completeManagedStartup(
      async () => {
        events.push("start");
      },
      {},
      run,
    ),
  ).rejects.toThrow("requires a systemd notify socket");
  expect(events).toEqual(["start"]);
});

it("extends the startup deadline only after new recovery progress", async () => {
  let clock = 0;
  const calls: string[][] = [],
    run: ReadinessRunner = (_binary, args) => {
      calls.push([...args]);
      return { code: 0, stderr: "" };
    };
  await completeManagedStartup(
    async (progress) => {
      clock = 59_999;
      progress();
      clock = 60_000;
      progress();
      progress();
      clock = 120_000;
      progress();
    },
    { NOTIFY_SOCKET: "/run/systemd/notify" },
    run,
    () => clock,
  );
  expect(calls).toEqual([
    ["EXTEND_TIMEOUT_USEC=900000000"],
    ["EXTEND_TIMEOUT_USEC=900000000"],
    ["--ready"],
  ]);
});
