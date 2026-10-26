import { HumanView, LoginResult, type LoginInput } from "@mate/auth";

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
  fetch: typeof fetch;
};

function serverAddress(input: string): string {
  const url = new URL(input.trim());
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("请输入 HTTPS 服务器地址，不含账号或路径。");
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
        await this.platform.clearCookies();
        this.publish({ kind: "signed-out", server: this.preferences.server, message: "" });
      }
    } catch {
      this.publish({ kind: "server", message: "无法读取本机登录设置，请重新保存服务器地址。" });
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
          try {
            this.platform.write({ server, restore: false });
            this.preferences = { server, restore: false };
            await this.platform.clearCookies();
          } catch {
            if (generation === this.generation)
              this.publish({
                kind: "unavailable",
                server,
                message: "无法清理本机登录设置，请重试退出登录后再登录。",
              });
            return;
          }
          if (generation === this.generation)
            this.publish({
              kind: "signed-out",
              server,
              message: input ? "Handle 或密码不对。" : "登录已失效，请重新登录。",
            });
        } else if (input) {
          this.publish({
            kind: "signed-out",
            server,
            message:
              error instanceof Refusal && error.status === 429
                ? "尝试的人太多了，请稍后再试。"
                : "无法完成登录，请检查网络和服务器后重试。",
          });
        } else {
          this.publish({
            kind: "unavailable",
            server,
            message: "无法连接或验证服务器，尚未确认登录是否有效。请检查网络后重试。",
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
        message: "请输入 HTTPS 服务器地址，例如 https://mate.example.com，不含账号或路径。",
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
        message: revoked
          ? revoke
            ? "已退出登录。"
            : ""
          : "已在本机退出；未能确认服务器撤销会话。",
      });
    } catch {
      this.publish({
        kind: "unavailable",
        server,
        message: "无法清理本机登录设置，请重试退出登录后再登录。",
      });
    }
  }
}
