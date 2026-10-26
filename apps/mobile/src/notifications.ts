import { ApnsSubscription, NativePushCapability, NativePushNotice } from "@mate/chat/push";
import { z } from "zod";

export type NotificationSession = { server: string; accountId: number };
export type NotificationPermission = "undetermined" | "denied" | "allowed" | "quiet";
export type NotificationDestination = Pick<NativePushNotice, "conversationId" | "threadId" | "seq">;
const Registration = z.object({
  server: z.string(),
  accountId: z.number().int().positive(),
  subscription: ApnsSubscription,
});
type Registration = z.output<typeof Registration>;
const Registrations = z.object({
  current: Registration.nullable(),
  cleanup: z.array(Registration),
});
type Registrations = z.output<typeof Registrations>;
export type NotificationState = {
  kind: "signed-out" | "checking" | "disabled" | "enabled" | "denied" | "unavailable";
  message: string;
};
export type NotificationsPlatform = {
  read(): unknown;
  write(value: Registrations | null): void;
  permission(request: boolean): Promise<NotificationPermission>;
  token(): Promise<string>;
  unregister(): Promise<void>;
  dismiss(): Promise<void>;
  fetch: typeof fetch;
  binding(): string;
  now(): number;
  environment: "sandbox" | "production";
  open(destination: NotificationDestination): void;
};

function same(a: NotificationSession | null, b: NotificationSession | null): boolean {
  return a?.server === b?.server && a?.accountId === b?.accountId;
}

function sameRegistration(a: Registration, b: Registration): boolean {
  return (
    same(a, b) &&
    a.subscription.token === b.subscription.token &&
    a.subscription.environment === b.subscription.environment &&
    a.subscription.binding === b.subscription.binding
  );
}

/** Owns the active registration and every unconfirmed cancellation across auth transitions. */
export class MobileNotifications {
  private state: NotificationState = { kind: "signed-out", message: "请先登录。" };
  private listeners = new Set<() => void>();
  private session: NotificationSession | null = null;
  private verified: NotificationSession | null = null;
  private registrations: Registrations;
  private pending: Promise<void> = Promise.resolve();
  private generation = 0;
  private request: AbortController | undefined;
  private tap: unknown;
  private opened = new Set<string>();

  constructor(private platform: NotificationsPlatform) {
    const stored = platform.read();
    const parsed = Registrations.safeParse(stored);
    const legacy = Registration.extend({ kind: z.enum(["subscribed", "cleanup"]) }).safeParse(
      stored,
    );
    this.registrations = parsed.success
      ? parsed.data
      : legacy.success
        ? {
            current: legacy.data.kind === "subscribed" ? legacy.data : null,
            cleanup: legacy.data.kind === "cleanup" ? [legacy.data] : [],
          }
        : { current: null, cleanup: [] };
  }

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish(kind: NotificationState["kind"], message: string) {
    this.state = { ...this.state, kind, message };
    this.listeners.forEach((listener) => listener());
  }

  private save(value: Registrations) {
    this.platform.write(value.current || value.cleanup.length ? value : null);
    this.registrations = value;
  }

  /** null suspends presentation/taps during auth validation without forgetting the registration. */
  setSession(session: NotificationSession | null): Promise<void> {
    if (!same(this.session, session)) {
      ++this.generation;
      this.request?.abort();
      this.session = session;
      this.publish(session ? "checking" : "signed-out", session ? "正在检查通知…" : "请先登录。");
    }
    if (session) {
      this.verified = session;
      this.consumeTap();
      return this.refresh();
    }
    return Promise.resolve();
  }

  private run(operation: (session: NotificationSession, current: () => boolean) => Promise<void>) {
    const session = this.session;
    const generation = this.generation;
    if (!session) return Promise.resolve();
    const current = () => generation === this.generation && same(session, this.session);
    this.pending = this.pending.then(async () => {
      if (!current()) return;
      try {
        await operation(session, current);
      } catch {
        if (current())
          this.publish(
            "unavailable",
            "无法完成通知设置，请检查网络、服务器和此 app 的推送签名后重试。",
          );
      }
    });
    return this.pending;
  }

  private async http(session: NotificationSession, path: string, body?: ApnsSubscription) {
    const request = new AbortController();
    this.request = request;
    const timeout = setTimeout(() => request.abort(), 10_000);
    try {
      const response = await this.platform.fetch(session.server + "/api/chat/push/" + path, {
        method: body ? "POST" : "GET",
        credentials: "include",
        signal: request.signal,
        ...(body
          ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
          : {}),
      });
      if (!response.ok) throw new Error(`notification request ${response.status}`);
      return body ? undefined : response.json();
    } finally {
      clearTimeout(timeout);
      if (this.request === request) this.request = undefined;
    }
  }

  refresh(): Promise<void> {
    return this.run(async (session, current) => {
      const permission = await this.platform.permission(false);
      if (!current()) return;
      if (permission === "denied") {
        const message = await this.remove(session);
        if (current())
          this.publish("denied", "系统已关闭通知。请在 iOS 设置中允许通知，再回来开启。" + message);
        return;
      }
      const cleanupMessage = await this.retire(session);
      if (!current()) return;
      const capability = NativePushCapability.parse(await this.http(session, "native"));
      if (!current()) return;
      if (!capability.enabled) {
        this.publish(
          "unavailable",
          "此服务器尚未配置 Apple 推送。允许系统通知后，仍需服务器配置完成才能接收远程通知。" +
            cleanupMessage,
        );
        return;
      }
      if (
        capability.server !== session.server ||
        capability.environment !== this.platform.environment
      ) {
        this.publish(
          "unavailable",
          "服务器的推送地址或环境与此 app 不一致，请检查推送配置。" + cleanupMessage,
        );
        return;
      }
      const registration = this.registrations.current;
      if (!registration || !same(session, registration)) {
        this.publish(
          "disabled",
          "通知尚未开启。只通知发给你的私信和提及，不显示消息正文。" + cleanupMessage,
        );
        return;
      }
      if (permission !== "allowed" && permission !== "quiet") {
        this.publish("disabled", "请允许系统通知后开启。" + cleanupMessage);
        return;
      }
      await this.register(session, current);
    });
  }

  enable(): Promise<void> {
    return this.run(async (session, current) => {
      this.publish("checking", "正在开启通知…");
      const permission = await this.platform.permission(true);
      if (!current()) return;
      if (permission === "denied" || permission === "undetermined") {
        const message = await this.remove(session);
        if (current())
          this.publish("denied", "未获得系统通知权限。请在 iOS 设置中允许通知。" + message);
        return;
      }
      const capability = NativePushCapability.parse(await this.http(session, "native"));
      if (!current()) return;
      if (!capability.enabled) {
        this.publish(
          "unavailable",
          "系统通知已允许；此服务器尚未配置 Apple 推送，远程通知尚未开启。",
        );
        return;
      }
      if (
        capability.server !== session.server ||
        capability.environment !== this.platform.environment
      ) {
        this.publish("unavailable", "服务器的推送地址或环境与此 app 不一致，请检查推送配置。");
        return;
      }
      await this.register(session, current);
    });
  }

  tokenChanged(token: string): Promise<void> {
    return this.run(async (session, current) => {
      const registration = this.registrations.current;
      if (
        !registration ||
        !same(session, registration) ||
        registration.subscription.token === token
      )
        return;
      await this.register(session, current, token);
    });
  }

  private async register(
    session: NotificationSession,
    current: () => boolean,
    providedToken?: string,
  ) {
    const token = providedToken ?? (await this.platform.token());
    if (!current()) return;
    const previous = this.registrations.current;
    const subscription = ApnsSubscription.parse({
      transport: "apns",
      token,
      environment: this.platform.environment,
      binding:
        previous &&
        same(previous, session) &&
        previous.subscription.token === token &&
        previous.subscription.environment === this.platform.environment
          ? previous.subscription.binding
          : this.platform.binding(),
    });
    const registration = { ...session, subscription };
    const cleanup = [...this.registrations.cleanup];
    if (
      previous &&
      !sameRegistration(previous, registration) &&
      !cleanup.some((entry) => sameRegistration(entry, previous))
    )
      cleanup.push(previous);
    // Persist both obligations before the request, including a potentially lost acknowledgement.
    this.save({
      current: registration,
      cleanup: cleanup.filter((entry) => !sameRegistration(entry, registration)),
    });
    await this.http(session, "subscribe", subscription);
    if (!current()) return;
    const message = await this.retire(session);
    if (!current()) return;
    this.publish(
      "enabled",
      "已向服务器登记通知。只通知私信和提及，不含消息正文；实际送达由 Apple 和系统设置决定。" +
        message,
    );
    this.consumeTap();
  }

  private async retire(session: NotificationSession | null): Promise<string> {
    for (const registration of this.registrations.cleanup) {
      if (!session || !same(session, registration)) continue;
      try {
        await this.http(session, "unsubscribe", registration.subscription);
        this.save({
          ...this.registrations,
          cleanup: this.registrations.cleanup.filter(
            (entry) => !sameRegistration(entry, registration),
          ),
        });
      } catch {
        /* Keep the scoped cancellation until the server acknowledges it. */
      }
    }
    return this.registrations.cleanup.length
      ? " 未能确认服务器取消订阅；旧登记已保留，回到对应服务器和账号后重试。重新允许推送后仍可能收到旧服务器的通知。"
      : "";
  }

  private async remove(session: NotificationSession | null): Promise<string> {
    const registration = this.registrations.current;
    if (registration)
      this.save({ current: null, cleanup: [...this.registrations.cleanup, registration] });
    let message = "通知已在本机关闭。";
    try {
      await this.platform.unregister();
      await this.platform.dismiss();
    } catch {
      message = "本机通知清理未确认，请在 iOS 设置中关闭通知。";
    }
    return message + (await this.retire(session));
  }

  disable(): Promise<void> {
    return this.run(async (session, current) => {
      this.publish("checking", "正在关闭通知…");
      const message = await this.remove(session);
      if (current()) this.publish("disabled", message);
    });
  }

  /** Auth awaits this barrier before logout/server-switch cookie cleanup, even if registration was in flight. */
  async endSession(): Promise<string> {
    ++this.generation;
    this.session = null;
    this.request?.abort();
    this.tap = undefined;
    this.opened.clear();
    this.publish("signed-out", "请先登录。");
    await this.pending;
    const message = await this.remove(this.verified);
    this.verified = null;
    return message;
  }

  private matching(data: unknown): NativePushNotice | null {
    const parsed = NativePushNotice.safeParse(data);
    const registration = this.registrations.current;
    if (!parsed.success || !this.session || !registration) return null;
    const notice = parsed.data;
    if (
      !same(notice, this.session) ||
      !same(registration, this.session) ||
      notice.binding !== registration.subscription.binding
    )
      return null;
    const age = this.platform.now() - notice.at;
    return age >= -60_000 && age < 86_400_000 ? notice : null;
  }

  shouldPresent(data: unknown): boolean {
    return this.matching(data) !== null;
  }

  response(data: unknown): void {
    this.tap = data;
    this.consumeTap();
  }

  private consumeTap() {
    if (!this.session) return;
    const notice = this.matching(this.tap);
    this.tap = undefined;
    if (!notice || this.opened.has(notice.tag)) return;
    this.opened.add(notice.tag);
    this.platform.open({
      conversationId: notice.conversationId,
      threadId: notice.threadId,
      seq: notice.seq,
    });
  }
}
