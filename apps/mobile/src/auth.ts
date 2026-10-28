import { t, noticeText } from "./i18n";
import { HumanView, LoginResult, type LoginInput } from "@mate/control-plane/contracts";

export type AuthState =
  | { kind: "starting" }
  | { kind: "server"; message: string }
  | { kind: "signed-out"; server: string; message: string }
  | { kind: "logging-in"; server: string }
  | { kind: "checking"; server: string }
  | { kind: "clearing"; server: string }
  | { kind: "signed-in"; server: string; human: HumanView }
  | { kind: "unavailable"; server: string; message: string };

type Preferences = { server: string; restore: boolean };
export type AuthPlatform = {
  read(): Preferences | null;
  write(preferences: Preferences): void;
  clearCookies(): Promise<unknown>;
  beforeClear?(): Promise<string>;
  fetch: typeof fetch;
};

function serverAddress(input: string): string {
  const url = new URL(input.trim());
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(t("auth.enter_an_https_server_address_without_credentials"));
  return url.origin;
}

class Refusal extends Error {
  constructor(readonly status: number) {
    super(String(status));
  }
}

/** Owns the one selected server and access to its current cookie session. */
export class MobileAuth {
  private state: AuthState = { kind: "starting" };
  private listeners = new Set<() => void>();
  private generation = 0;
  private request: AbortController | undefined;
  private pending: Promise<void> = Promise.resolve();
  private preferences: Preferences | null = null;
  private cleanup: { server: string; revoke: boolean } | undefined;

  constructor(private platform: AuthPlatform) {}

  getSnapshot = (): AuthState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Accept a profile response only for the login that submitted it. */
  updateHuman(previous: Extract<AuthState, { kind: "signed-in" }>, human: HumanView): void {
    if (this.state !== previous || human.accountId !== previous.human.accountId) return;
    this.publish({ ...previous, human });
  }

  private publish(state: AuthState) {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }

  async start(): Promise<void> {
    if (this.state.kind !== "starting") return;
    try {
      this.preferences = this.platform.read();
      if (this.preferences === null) {
        await this.platform.clearCookies();
        this.publish({ kind: "server", message: "" });
      } else if (this.preferences.restore) {
        await this.revalidate();
      } else {
        const message = (await this.platform.beforeClear?.()) ?? "";
        await this.platform.clearCookies();
        this.publish({ kind: "signed-out", server: this.preferences.server, message });
      }
    } catch {
      this.publish({
        kind: "server",
        message: t("auth.could_not_read_local_signin_settings_save"),
      });
    }
  }

  private async json(server: string, path: string, signal: AbortSignal, body?: LoginInput) {
    const response = await this.platform.fetch(server + path, {
      method: body === undefined ? "GET" : "POST",
      credentials: "include",
      signal,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
    if (!response.ok) throw new Refusal(response.status);
    return response.json();
  }

  login(handle: string, password: string): Promise<void> {
    if (this.state.kind !== "signed-out") return Promise.resolve();
    return this.authenticate({ handle, password });
  }

  revalidate(): Promise<void> {
    if (!this.preferences?.restore || this.request || this.cleanup) return Promise.resolve();
    return this.authenticate();
  }

  private authenticate(input?: LoginInput): Promise<void> {
    const preferences = this.preferences;
    if (!preferences) return Promise.resolve();
    const server = preferences.server;
    const generation = this.generation;
    const request = new AbortController();
    const timeout = setTimeout(() => request.abort(), 15_000);
    this.request = request;
    this.publish({ kind: input ? "logging-in" : "checking", server });
    this.pending = (async () => {
      try {
        if (input) LoginResult.parse(await this.json(server, "/api/login", request.signal, input));
        if (generation !== this.generation) return;
        const human = HumanView.parse(await this.json(server, "/api/me", request.signal));
        if (generation !== this.generation) return;
        this.platform.write({ server, restore: true });
        this.preferences = { server, restore: true };
        this.publish({ kind: "signed-in", server, human });
      } catch (error) {
        if (generation !== this.generation) return;
        if (error instanceof Refusal && error.status === 401) {
          let notificationMessage = "";
          try {
            this.platform.write({ server, restore: false });
            this.preferences = { server, restore: false };
            notificationMessage = (await this.platform.beforeClear?.()) ?? "";
            await this.platform.clearCookies();
          } catch {
            if (generation === this.generation)
              this.publish({
                kind: "unavailable",
                server,
                message: t("auth.could_not_clear_local_signin_settings_try"),
              });
            return;
          }
          if (generation === this.generation)
            this.publish({
              kind: "signed-out",
              server,
              message: noticeText(
                input
                  ? t("auth.incorrect_handle_or_password")
                  : t("auth.your_session_has_expired_sign_in_again"),
                notificationMessage,
              ),
            });
        } else if (input) {
          this.publish({
            kind: "signed-out",
            server,
            message:
              error instanceof Refusal && error.status === 429
                ? t("auth.too_many_people_are_trying_try_again")
                : t("auth.could_not_sign_in_check_your_network"),
          });
        } else {
          this.publish({
            kind: "unavailable",
            server,
            message: t("auth.could_not_connect_to_or_verify_the"),
          });
        }
      } finally {
        clearTimeout(timeout);
        if (this.request === request) this.request = undefined;
      }
    })();
    return this.pending;
  }

  async changeServer(input: string): Promise<void> {
    if (this.state.kind === "clearing" || this.state.kind === "starting") return;
    let server: string;
    try {
      server = serverAddress(input);
    } catch {
      this.publish({
        kind: "server",
        message: t("auth.enter_an_https_server_address_such_as"),
      });
      return;
    }
    await this.clearLocal(server, false);
  }

  async logout(): Promise<void> {
    if (!this.preferences || this.state.kind === "clearing") return;
    await this.clearLocal(this.preferences.server, true);
  }

  retry(): Promise<void> {
    if (this.state.kind === "clearing") return Promise.resolve();
    if (this.cleanup) return this.clearLocal(this.cleanup.server, this.cleanup.revoke);
    return this.preferences?.restore ? this.revalidate() : this.logout();
  }

  private async clearLocal(server: string, revoke: boolean): Promise<void> {
    this.cleanup = { server, revoke };
    ++this.generation;
    this.request?.abort();
    const pending = this.pending;
    this.publish({ kind: "clearing", server });
    try {
      // Persist denial before touching cookies: iOS may flush its cookie jar later.
      this.platform.write({ server, restore: false });
      this.preferences = { server, restore: false };
      await pending;
      const notificationMessage = (await this.platform.beforeClear?.()) ?? "";
      let revoked = !revoke;
      if (revoke) {
        const request = new AbortController();
        const timeout = setTimeout(() => request.abort(), 10_000);
        try {
          const response = await this.platform.fetch(server + "/api/logout", {
            method: "POST",
            credentials: "include",
            signal: request.signal,
            headers: { "content-type": "application/json" },
            body: "{}",
          });
          revoked = response.ok;
        } catch {
          revoked = false;
        } finally {
          clearTimeout(timeout);
        }
      }
      await this.platform.clearCookies();
      this.cleanup = undefined;
      this.publish({
        kind: "signed-out",
        server,
        message: noticeText(
          revoked
            ? revoke
              ? t("auth.signed_out")
              : ""
            : t("auth.signed_out_on_this_device_server_session"),
          notificationMessage,
        ),
      });
    } catch {
      this.publish({
        kind: "unavailable",
        server,
        message: t("auth.could_not_clear_local_signin_settings_try"),
      });
    }
  }
}
