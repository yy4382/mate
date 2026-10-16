import { join } from "node:path";
import { temporaryDirectory } from "@mate/testkit";
import type { Clock } from "@mate/clock";
import { ChatApp, ChatError } from "../src/index.ts";

/** A fresh requestId for setup calls whose idempotency a test does not exercise. */
let counter = 0;
export const rid = () => `setup-${++counter}`;

export function newApp(options: { clock?: Clock } = {}): ChatApp {
  return new ChatApp(join(temporaryDirectory(), "chat.sqlite"), options);
}

/**
 * An app on a file the caller owns, so a test can close it and open the same file again. Closing and
 * reopening is how the tests stand in for a process restart.
 */
export function openAppAt(file: string): ChatApp {
  return new ChatApp(file);
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

export function newAppWithOwner() {
  const app = newApp();
  const ownerId = app.ensureAccount({
    externalId: "owner-ext",
    displayName: "Owner",
    handle: "owner",
    role: "owner",
  });
  return { app, ownerId };
}

export function newAppWithTwo() {
  const app = newApp();
  const alice = app.ensureAccount({
    externalId: "alice-ext",
    displayName: "Alice",
    handle: "alice",
  });
  const bob = app.ensureAccount({
    externalId: "bob-ext",
    displayName: "Bob",
    handle: "bob",
  });
  return { app, alice, bob };
}
