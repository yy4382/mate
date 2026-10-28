import { ApnsSubscription, NativePushCapability, NativePushNotice } from "@mate/chat/push";
import { z } from "zod";

type NotificationSession = { server: string; accountId: number };
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
} satisfies Omit<NotificationState, "kind">;
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
  private state: NotificationState = { kind: "signed-out", ...uncheckedFacts };
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
    const stored = Registrations.safeParse(platform.read());
    this.registrations = stored.success ? stored.data : { current: null, cleanup: [] };
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
    facts: Partial<Omit<NotificationState, "kind" | "registration" | "pendingCancellations">> = {},
  ) {
    const registration = this.registrations.current;
    this.state = {
      ...this.state,
      ...facts,
      kind,
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
    if (same(this.session, session)) return Promise.resolve();
    ++this.generation;
    this.request?.abort();
    this.session = session;
    this.publish(session ? "checking" : "signed-out", uncheckedFacts);
    if (!session) return Promise.resolve();
    this.verified = session;
    this.consumeTap();
    return this.refresh();
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
        if (current()) this.publish("unavailable");
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

  /** Publishes whether this server can push to this app; registration continues only when it can. */
  private async checkCapability(session: NotificationSession, current: () => boolean) {
    const capability = NativePushCapability.parse(await this.http(session, "native"));
    if (!current()) return false;
    const server = !capability.enabled
      ? "unconfigured"
      : capability.server !== session.server || capability.environment !== this.platform.environment
        ? "mismatch"
        : "available";
    this.publish(server === "available" ? this.state.kind : "unavailable", { server });
    return server === "available";
  }

  refresh(): Promise<void> {
    return this.run(async (session, current) => {
      this.publish("checking");
      const permission = await this.platform.permission(false);
      if (!current()) return;
      this.publish(this.state.kind, { permission });
      if (permission === "denied") {
        await this.remove(session);
        if (current()) this.publish("denied");
        return;
      }
      await this.retire(session);
      if (!current() || !(await this.checkCapability(session, current))) return;
      const registration = this.registrations.current;
      if (
        !registration ||
        !same(session, registration) ||
        (permission !== "allowed" && permission !== "quiet")
      ) {
        this.publish("disabled");
        return;
      }
      await this.register(session, current);
    });
  }

  enable(): Promise<void> {
    return this.run(async (session, current) => {
      this.publish("checking");
      const permission = await this.platform.permission(true);
      if (!current()) return;
      this.publish(this.state.kind, { permission });
      if (permission === "denied" || permission === "undetermined") {
        await this.remove(session);
        if (current()) this.publish("denied");
        return;
      }
      if (await this.checkCapability(session, current)) await this.register(session, current);
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
    await this.retire(session);
    if (current()) this.publish("enabled");
  }

  private async retire(session: NotificationSession | null) {
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
  }

  private async remove(session: NotificationSession | null) {
    const registration = this.registrations.current;
    if (registration)
      this.save({ current: null, cleanup: [...this.registrations.cleanup, registration] });
    try {
      await this.platform.unregister();
      await this.platform.dismiss();
      this.publish(this.state.kind, { localCleanup: "complete" });
    } catch {
      this.publish(this.state.kind, { localCleanup: "unconfirmed" });
    }
    await this.retire(session);
    this.publish(this.state.kind);
  }

  disable(): Promise<void> {
    return this.run(async (session, current) => {
      this.publish("checking");
      await this.remove(session);
      if (current()) this.publish("disabled");
    });
  }

  /** Auth awaits this barrier before logout/server-switch cookie cleanup, even if registration was in flight. */
  async endSession(): Promise<void> {
    ++this.generation;
    this.session = null;
    this.request?.abort();
    this.tap = undefined;
    this.opened.clear();
    this.publish("signed-out", uncheckedFacts);
    await this.pending;
    await this.remove(this.verified);
    this.verified = null;
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
