export const MAX_CONCURRENT_LOGIN_CHECKS = 2;

type PasswordCheck = "unconfigured" | "valid" | "invalid";

export type LoginCheckOutcome =
  { kind: "checked"; result: PasswordCheck } | { kind: "limited"; retryAfterSeconds: 1 };

/** Shared bound for expensive credential checks in one control plane. */
export class LoginGate {
  private activeChecks = 0;

  async run(check: () => Promise<PasswordCheck>): Promise<LoginCheckOutcome> {
    if (this.activeChecks >= MAX_CONCURRENT_LOGIN_CHECKS)
      return { kind: "limited", retryAfterSeconds: 1 };

    this.activeChecks++;
    try {
      const result = await check();
      return { kind: "checked", result };
    } finally {
      this.activeChecks--;
    }
  }
}
