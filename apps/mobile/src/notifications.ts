import { t, noticeText } from "./i18n";
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
  permission: NotificationPermission | "unknown";
  server: "unknown" | "available" | "unconfigured" | "mismatch";
  registration: "none" | "unconfirmed" | "registered";
  pendingCancellations: number;
  localCleanup: "unknown" | "complete" | "unconfirmed";
};
const uncheckedFacts = {
  permission: "unknown",
  server: "unknown",
  registration: "none",
  pendingCancellations: 0,
  localCleanup: "unknown",
} satisfies Omit<NotificationState, "kind" | "message">;
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
  private state: NotificationState = {
    kind: "signed-out",
    message: t("settings.sign_in_first"),
    ...uncheckedFacts,
  };
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

  private publish(
    kind: NotificationState["kind"],
    message: string,
    facts: Partial<
      Omit<NotificationState, "kind" | "message" | "registration" | "pendingCancellations">
    > = {},
  ) {
    const registration = this.registrations.current;
    this.state = {
      ...this.state,
      ...facts,
      kind,
      message,
      registration:
        registration && same(this.session, registration)
          ? kind === "enabled"
            ? "registered"
            : "unconfirmed"
          : "none",
      pendingCancellations: this.registrations.cleanup.length,
    };
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
      this.publish(
        session ? "checking" : "signed-out",
        session ? t("settings.checking_notifications") : t("settings.sign_in_first"),
        uncheckedFacts,
      );
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
            t("settings.could_not_configure_notifications_check_your_network"),
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
      this.publish("checking", t("settings.checking_notifications"));
      const permission = await this.platform.permission(false);
      if (!current()) return;
      this.publish(this.state.kind, this.state.message, { permission });
      if (permission === "denied") {
        const message = await this.remove(session);
        if (current())
          this.publish(
            "denied",
            noticeText(t("settings.system_notifications_are_off_allow_notifications_in"), message),
          );
        return;
      }
      const cleanupMessage = await this.retire(session);
      if (!current()) return;
      const capability = NativePushCapability.parse(await this.http(session, "native"));
      if (!current()) return;
      this.publish(this.state.kind, this.state.message, {
        server: !capability.enabled
          ? "unconfigured"
          : capability.server !== session.server ||
              capability.environment !== this.platform.environment
            ? "mismatch"
            : "available",
      });
      if (!capability.enabled) {
        this.publish(
          "unavailable",
          noticeText(t("settings.this_server_has_not_configured_apple_push"), cleanupMessage),
        );
        return;
      }
      if (
        capability.server !== session.server ||
        capability.environment !== this.platform.environment
      ) {
        this.publish(
          "unavailable",
          noticeText(t("settings.the_servers_push_origin_or_environment_does"), cleanupMessage),
        );
        return;
      }
      const registration = this.registrations.current;
      if (!registration || !same(session, registration)) {
        this.publish(
          "disabled",
          noticeText(t("settings.notifications_are_off_only_direct_messages_and"), cleanupMessage),
        );
        return;
      }
      if (permission !== "allowed" && permission !== "quiet") {
        this.publish(
          "disabled",
          noticeText(t("settings.allow_system_notifications_before_enabling_them"), cleanupMessage),
        );
        return;
      }
      await this.register(session, current);
    });
  }

  enable(): Promise<void> {
    return this.run(async (session, current) => {
      this.publish("checking", t("settings.enabling_notifications"));
      const permission = await this.platform.permission(true);
      if (!current()) return;
      this.publish(this.state.kind, this.state.message, { permission });
      if (permission === "denied" || permission === "undetermined") {
        const message = await this.remove(session);
        if (current())
          this.publish(
            "denied",
            noticeText(
              t("settings.notification_permission_was_not_granted_allow_notifications"),
              message,
            ),
          );
        return;
      }
      const capability = NativePushCapability.parse(await this.http(session, "native"));
      if (!current()) return;
      this.publish(this.state.kind, this.state.message, {
        server: !capability.enabled
          ? "unconfigured"
          : capability.server !== session.server ||
              capability.environment !== this.platform.environment
            ? "mismatch"
            : "available",
      });
      if (!capability.enabled) {
        this.publish("unavailable", t("settings.system_notifications_are_allowed_but_this_server"));
        return;
      }
      if (
        capability.server !== session.server ||
        capability.environment !== this.platform.environment
      ) {
        this.publish("unavailable", t("settings.the_servers_push_origin_or_environment_does"));
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
      noticeText(t("settings.notifications_registered_with_the_server_only_direct"), message),
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
      ? t("settings.server_unsubscription_could_not_be_confirmed_the")
      : "";
  }

  private async remove(session: NotificationSession | null): Promise<string> {
    const registration = this.registrations.current;
    if (registration)
      this.save({ current: null, cleanup: [...this.registrations.cleanup, registration] });
    let message = t("settings.notifications_are_off_on_this_device");
    try {
      await this.platform.unregister();
      await this.platform.dismiss();
      this.publish(this.state.kind, this.state.message, { localCleanup: "complete" });
    } catch {
      this.publish(this.state.kind, this.state.message, { localCleanup: "unconfirmed" });
      message = t("settings.local_notification_cleanup_is_unconfirmed_turn_off");
    }
    const cancellation = await this.retire(session);
    this.publish(this.state.kind, this.state.message);
    return noticeText(message, cancellation);
  }

  disable(): Promise<void> {
    return this.run(async (session, current) => {
      this.publish("checking", t("settings.disabling_notifications"));
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
    this.publish("signed-out", t("settings.sign_in_first"), uncheckedFacts);
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
