import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { watchServiceStatus } from "../src/status-monitor.js";

const statusResponse = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;

const flushPromises = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("shows connection loss and recovers when a later status check succeeds", async () => {
  const fetchStatus = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(statusResponse({ status: "running" }))
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(statusResponse({ status: "running" }));
  const states: string[] = [];
  const stop = watchServiceStatus((state) => states.push(state), fetchStatus, 10);

  try {
    await flushPromises();
    expect(states).toEqual(["running"]);
    await vi.advanceTimersByTimeAsync(10);
    await flushPromises();
    expect(states).toEqual(["running", "unavailable"]);
    await vi.advanceTimersByTimeAsync(10);
    await flushPromises();
    expect(states).toEqual(["running", "unavailable", "running"]);
  } finally {
    stop();
  }
});

it("waits for a check to finish before scheduling another and stops cleanly", async () => {
  let finishFirstCheck!: (response: Response) => void;
  const fetchStatus = vi.fn<typeof fetch>(
    () =>
      new Promise((resolve) => {
        finishFirstCheck = resolve;
      }),
  );
  const onState = vi.fn();
  const stop = watchServiceStatus(onState, fetchStatus, 10);

  try {
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(fetchStatus).toHaveBeenCalledTimes(1);

    finishFirstCheck(statusResponse({ status: "running" }));
    await flushPromises();
    expect(onState).toHaveBeenCalledWith("running");
    await vi.advanceTimersByTimeAsync(10);
    expect(fetchStatus).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  } finally {
    stop();
  }
});
