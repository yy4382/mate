export const MAX_CONCURRENT_LOGIN_CHECKS = 2;
export const MAX_FAILED_LOGINS_PER_WINDOW = 5;
export const LOGIN_FAILURE_WINDOW_MS = 60_000;

type PasswordCheck = "unconfigured" | "valid" | "invalid";

export type LoginCheckOutcome =
  | { kind: "checked"; result: PasswordCheck }
  | { kind: "limited"; retryAfterSeconds: number; reason: "busy" | "failures" };

/** Shared bound for expensive credential checks and recent failed attempts in one control plane. */
export class LoginGate {
  private activeChecks = 0;
  private readonly failedAt: number[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  async run(check: () => Promise<PasswordCheck>): Promise<LoginCheckOutcome> {
    const now = this.now();
    for (let index = this.failedAt.length - 1; index >= 0; index--)
      if (this.failedAt[index]! + LOGIN_FAILURE_WINDOW_MS <= now) this.failedAt.splice(index, 1);

    if (this.failedAt.length + this.activeChecks >= MAX_FAILED_LOGINS_PER_WINDOW) {
      const retryAfterMs = Math.min(...this.failedAt) + LOGIN_FAILURE_WINDOW_MS - now;
      return {
        kind: "limited",
        reason: "failures",
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      };
    }
    if (this.activeChecks >= MAX_CONCURRENT_LOGIN_CHECKS)
      return { kind: "limited", reason: "busy", retryAfterSeconds: 1 };

    this.activeChecks++;
    try {
      const result = await check();
      if (result === "invalid") this.failedAt.push(this.now());
      else if (result === "valid") this.failedAt.length = 0;
      return { kind: "checked", result };
    } finally {
      this.activeChecks--;
    }
  }
}
