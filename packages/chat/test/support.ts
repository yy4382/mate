import { join } from "node:path";
import { temporaryDirectory } from "@mate/testkit";
import type { Clock } from "@mate/clock";
import { vi } from "vitest";
import {
  ChatApp,
  ChatError,
  type PushNotice,
  type PushSender,
  type PushSubscription,
} from "../src/index.ts";

type AppOptions = { clock?: Clock; push?: PushSender };

/** A fresh requestId for setup calls whose idempotency a test does not exercise. */
let counter = 0;
export const rid = () => `setup-${++counter}`;

export function newApp(options: AppOptions = {}): ChatApp {
  return new ChatApp(join(temporaryDirectory(), "chat.sqlite"), options);
}

/**
 * An app on a file the caller owns, so a test can close it and open the same file again. Closing and
 * reopening is how the tests stand in for a process restart.
 */
export function openAppAt(file: string, options: AppOptions = {}): ChatApp {
  return new ChatApp(file, options);
}

/** The reason a refused call reports, or a marker string when it unexpectedly succeeded. */
export function refusalReason(call: () => unknown): string {
  try {
    call();
    return "no-refusal";
  } catch (error) {
    if (error instanceof ChatError) return error.reason;
    throw error;
  }
}

export function newAppWithOwner(options: AppOptions = {}) {
  const app = newApp(options);
  const ownerId = app.ensureAccount({
    externalId: "owner-ext",
    displayName: "Owner",
    handle: "owner",
    kind: "human",
  });
  return { app, ownerId };
}

export function newAppWithTwo() {
  const app = newApp();
  const alice = app.ensureAccount({
    externalId: "alice-ext",
    displayName: "Alice",
    handle: "alice",
    kind: "agent",
  });
  const bob = app.ensureAccount({
    externalId: "bob-ext",
    displayName: "Bob",
    handle: "bob",
    kind: "agent",
  });
  return { app, alice, bob };
}

/** What a push service answers: an HTTP status, a failed connection, or nothing until `release`. */
export type PushAnswer = number | "unreachable" | "hang";

/**
 * The Web Push service, as the chat app's `PushSender` reaches it. It records every request with the time it arrived
 * and answers each endpoint from that endpoint's script, then with 201 Created.
 */
export class FakePushService {
  readonly requests: { subscription: PushSubscription; notice: PushNotice; at: number }[] = [];
  readonly #scripts = new Map<string, PushAnswer[]>();
  readonly #held: ((status: number) => void)[] = [];
  readonly #clock: Clock;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  /** Answer the next requests to `endpoint` with `answers`, in order, then with 201 Created. */
  answer(endpoint: string, ...answers: PushAnswer[]): void {
    this.#scripts.set(endpoint, [...(this.#scripts.get(endpoint) ?? []), ...answers]);
  }

  readonly send: PushSender = async (subscription, notice) => {
    this.requests.push({ subscription, notice, at: this.#clock.now() });
    const answer = this.#scripts.get(subscription.endpoint)?.shift() ?? 201;
    if (answer === "unreachable") throw new Error("push service unreachable");
    if (answer === "hang") return new Promise<number>((resolve) => this.#held.push(resolve));
    return answer;
  };

  /** Answer every request held by "hang" with `status`. */
  release(status: number): void {
    for (const resolve of this.#held.splice(0)) resolve(status);
  }

  /** Wait until `count` requests have arrived in all, and the chat app has taken in the answer to the last. */
  async received(count: number): Promise<void> {
    await vi.waitFor(() => {
      if (this.requests.length < count)
        throw new Error(`${this.requests.length} of ${count} push requests arrived`);
    });
    await settled();
  }

  /** The endpoints the requests went to, in arrival order. */
  endpoints(): string[] {
    return this.requests.map((request) => request.subscription.endpoint);
  }
}

/** Let the push delivery loop do everything it can without the clock moving. */
export async function settled(): Promise<void> {
  for (let turn = 0; turn < 3; turn++) await new Promise((resolve) => setImmediate(resolve));
}

/** A browser's push subscription for a device called `device`. */
export function subscription(device: string) {
  return {
    endpoint: `https://push.example/${device}`,
    keys: { p256dh: `p256dh-${device}`, auth: `auth-${device}` },
  };
}
