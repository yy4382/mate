import { ApnsSubscription, NativePushCapability, NativePushNotice } from "@mate/chat/push";
import { z } from "zod";

export type NotificationSession = { server: string; accountId: number };
export type NotificationPermission = "undetermined" | "denied" | "allowed" | "quiet";
export type NotificationDestination = Pick<NativePushNotice, "conversationId" | "threadId" | "seq">;
const Registration = z.object({
  kind: z.enum(["subscribed", "cleanup"]),
  server: z.string(),
  accountId: z.number().int().positive(),
  subscription: ApnsSubscription,
});
type Registration = z.output<typeof Registration>;
export type NotificationState = {
  kind: "signed-out" | "checking" | "disabled" | "enabled" | "denied" | "unavailable";
  message: string;
};
export type NotificationsPlatform = {
  read(): unknown;
  write(value: Registration | null): void;
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

/** Owns one native registration. An auth transition invalidates work before cookies can change. */
export class MobileNotifications {
  private state: NotificationState = { kind: "signed-out", message: "请先登录。" };
  private listeners = new Set<() => void>();
  private session: NotificationSession | null = null;
  private verified: NotificationSession | null = null;
  private registration: Registration | null;
  private pending: Promise<void> = Promise.resolve();
  private generation = 0;
  private request: AbortController | undefined;
  private tap: unknown;
  private opened = new Set<string>();

  constructor(private platform: NotificationsPlatform) {
    const parsed = Registration.nullable().safeParse(platform.read());
    this.registration = parsed.success ? parsed.data : null;
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

  private save(value: Registration | null) {
    this.platform.write(value);
    this.registration = value;
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
      if (this.registration?.kind === "cleanup" && same(session, this.registration))
        await this.remove(session);
      if (!current()) return;
      const capability = NativePushCapability.parse(await this.http(session, "native"));
      if (!current()) return;
      if (!capability.enabled) {
        this.publish(
          "unavailable",
          "此服务器尚未配置 Apple 推送。允许系统通知后，仍需服务器配置完成才能接收远程通知。",
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
      const registration = this.registration;
      if (!registration || registration.kind !== "subscribed" || !same(session, registration)) {
        this.publish("disabled", "通知尚未开启。只通知发给你的私信和提及，不显示消息正文。");
        return;
      }
      if (permission !== "allowed" && permission !== "quiet") {
        this.publish("disabled", "请允许系统通知后开启。");
        return;
      }
      await this.register(session, registration.subscription.binding, current);
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
      const binding =
        this.registration?.kind === "subscribed" && same(session, this.registration)
          ? this.registration.subscription.binding
          : this.platform.binding();
      await this.register(session, binding, current);
    });
  }

  tokenChanged(token: string): Promise<void> {
    return this.run(async (session, current) => {
      const registration = this.registration;
      if (
        registration?.kind !== "subscribed" ||
        !same(session, registration) ||
        registration.subscription.token === token
      )
        return;
      await this.register(session, registration.subscription.binding, current, token);
    });
  }

  private async register(
    session: NotificationSession,
    binding: string,
    current: () => boolean,
    providedToken?: string,
  ) {
    const token = providedToken ?? (await this.platform.token());
    if (!current()) return;
    const subscription = ApnsSubscription.parse({
      transport: "apns",
      token,
      environment: this.platform.environment,
      binding,
    });
    const previous = this.registration;
    // Persist before the request, so a lost acknowledgement can still be unsubscribed.
    this.save({ kind: "subscribed", ...session, subscription });
    await this.http(session, "subscribe", subscription);
    if (!current()) return;
    if (previous && same(previous, session) && previous.subscription.token !== token)
      await this.http(session, "unsubscribe", previous.subscription);
    if (!current()) return;
    this.publish(
      "enabled",
      "已向服务器登记通知。只通知私信和提及，不含消息正文；实际送达由 Apple 和系统设置决定。",
    );
    this.consumeTap();
  }

  private async remove(session: NotificationSession | null): Promise<string> {
    const registration = this.registration;
    if (registration) this.save({ ...registration, kind: "cleanup" });
    let message = "通知已在本机关闭。";
    try {
      await this.platform.unregister();
      await this.platform.dismiss();
    } catch {
      message = "本机通知清理未确认，请在 iOS 设置中关闭通知。";
    }
    if (registration) {
      if (same(session, registration) && session) {
        try {
          await this.http(session, "unsubscribe", registration.subscription);
          this.save(null);
        } catch {
          message += " 未能确认服务器取消订阅；重新允许推送后仍可能收到旧服务器的通知。";
        }
      } else message += " 旧服务器的取消订阅尚未确认。";
    }
    return message;
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
    const registration = this.registration;
    if (!parsed.success || !this.session || registration?.kind !== "subscribed") return null;
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
