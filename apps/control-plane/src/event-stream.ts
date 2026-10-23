import type { ServerResponse } from "node:http";
import type { AgentEvent, EventWatch } from "@mate/admin";
import type { ChatApp } from "@mate/chat";
import type { Clock } from "@mate/clock";
import type { OwnerLogin } from "./login.ts";

/**
 * A comment line this often keeps proxies from closing an idle stream. Each heartbeat checks the session first, so an
 * idle stream ends within this long of the session expiring.
 */
const HEARTBEAT_MS = 25_000;

/**
 * A server-sent event stream that lives only as long as the owner's session. Every event is sent only while the
 * session is live; once it has ended (expired or logged out) the stream sends `login` and closes, and sends nothing
 * after. A stream with nothing to send notices the session's end at its next heartbeat.
 *
 * The response starts on `open()` or the first event, so a route can still refuse with an ordinary error before that.
 */
export class EventStream {
  readonly #response: ServerResponse;
  readonly #login: OwnerLogin;
  readonly #token: string;
  readonly #clock: Clock;
  readonly #closed = new AbortController();

  constructor(response: ServerResponse, login: OwnerLogin, token: string, clock: Clock) {
    this.#response = response;
    this.#login = login;
    this.#token = token;
    this.#clock = clock;
    response.on("close", () => this.#closed.abort());
  }

  open(): void {
    if (this.#response.headersSent) return;
    this.#response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    });
    this.#response.flushHeaders();
  }

  /** Send one event; false when the stream has ended, which this send may have done because the session ended. */
  send(event: string, data: unknown, id?: string): boolean {
    if (!this.#live()) return false;
    this.#response.write(
      `${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
    );
    return true;
  }

  /** Send a last event, then close. */
  finish(event: string, data: unknown = {}): void {
    if (this.send(event, data)) this.#response.end();
  }

  /**
   * Wait until `signal` aborts or a heartbeat is due. Resolves with whether the stream is still open: it closes when
   * the client leaves or the session ends.
   */
  async wait(signal: AbortSignal): Promise<boolean> {
    if (!this.#live()) return false;
    await this.#clock.sleep(HEARTBEAT_MS, AbortSignal.any([signal, this.#closed.signal]));
    if (signal.aborted) return !this.#closed.signal.aborted;
    if (!this.#live()) return false;
    this.#response.write(": ping\n\n");
    return true;
  }

  /** Whether the stream is open and its session live. When the session has ended, the stream ends with `login`. */
  #live(): boolean {
    if (this.#closed.signal.aborted) return false;
    this.open();
    if (this.#login.session(this.#token) !== undefined) return true;
    this.#response.end("event: login\ndata: {}\n\n");
    this.#closed.abort();
    return false;
  }
}

/**
 * The owner's live chat view after `cursor`: each read of `liveEvents` is one `events` event whose id is the cursor
 * after it, so a client reconnecting with `Last-Event-ID` resumes exactly there. A cursor that cannot be followed gets
 * `resnapshot` and the stream closes; the client loads a new snapshot and follows its cursor.
 */
export async function streamLive(
  stream: EventStream,
  chat: ChatApp,
  owner: number,
  cursor: string,
): Promise<void> {
  stream.open();
  let wake = new AbortController();
  const unwatch = chat.watchLive(() => wake.abort());
  try {
    do {
      // A signal during the reads below aborts this controller, so the wait after them returns at once.
      wake = new AbortController();
      for (;;) {
        const read = chat.liveEvents(owner, cursor);
        if (read.status === "resnapshot") return stream.finish("resnapshot");
        cursor = read.cursor;
        if (read.events.length === 0) break;
        if (!stream.send("events", read, cursor)) return;
      }
    } while (await stream.wait(wake.signal));
  } finally {
    unwatch();
  }
}

/**
 * An Agent's conversation as it happens: each batch of agent events is one `events` event, the first a snapshot. When
 * the watch ends (the Agent paused, deleted, or the control plane stopping) the stream sends `ended` and closes.
 * `watch` refuses before the stream starts, so a refusal is an ordinary error response.
 */
export async function streamAgent(
  stream: EventStream,
  watch: (listener: (events: readonly AgentEvent[]) => void) => Promise<EventWatch>,
): Promise<void> {
  const ended = new AbortController();
  const watching = await watch((events) => {
    if (!stream.send("events", events)) ended.abort();
  });
  void watching.ended.then(() => ended.abort());
  try {
    while (await stream.wait(ended.signal)) {
      if (ended.signal.aborted) return stream.finish("ended");
    }
  } finally {
    await watching.stop();
  }
}
