import { systemClock, type Clock } from "@mate/clock";
import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../src/index.ts";

/** Whether `promise` has settled by the time every callback already due has run. */
async function settledSoon(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(() => (settled = true));
  await new Promise((resolve) => setTimeout(resolve, 20));
  return settled;
}

const clocks: [string, () => Clock & { advance?: (ms: number) => void }][] = [
  ["the system clock", () => systemClock],
  ["the fake clock", () => new FakeClock()],
];

describe.each(clocks)("%s", (_name, make) => {
  it("returns at once from a sleep on a signal that has already aborted, with or without a deadline", async () => {
    const clock = make();
    const aborted = AbortSignal.abort();
    expect(await settledSoon(clock.sleep(undefined, aborted)), "no deadline").toBe(true);
    expect(await settledSoon(clock.sleep(60_000, aborted)), "a deadline").toBe(true);
  });

  it("sleeps without a deadline until the signal aborts, however much time passes", async () => {
    const clock = make();
    const controller = new AbortController();
    const sleeping = clock.sleep(undefined, controller.signal);
    clock.advance?.(365 * 24 * 60 * 60_000);
    expect(await settledSoon(sleeping), "still asleep").toBe(false);
    controller.abort();
    expect(await settledSoon(sleeping), "woken by the abort").toBe(true);
  });

  it("sleeps past the platform timer's limit of 2^31-1 ms instead of waking at once, and still wakes on abort", async () => {
    const clock = make();
    const controller = new AbortController();
    const sleeping = clock.sleep(2 ** 31 + 1_000, controller.signal);
    expect(await settledSoon(sleeping), "still asleep").toBe(false);
    controller.abort();
    expect(await settledSoon(sleeping), "woken by the abort").toBe(true);
    expect(getEventListeners(controller.signal, "abort"), "the abort listener is removed").toEqual(
      [],
    );
  });

  it("leaves no listener on the signal once a sleep has ended by its deadline", async () => {
    const clock = make();
    const signal = new AbortController().signal;
    const sleeping = clock.sleep(1, signal);
    clock.advance?.(1);
    await sleeping;
    expect(getEventListeners(signal, "abort"), "the abort listener is removed").toEqual([]);
  });
});
