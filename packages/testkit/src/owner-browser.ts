import { onTestFinished } from "vitest";

export type Answer = {
  readonly status: number;
  readonly headers: Headers;
  readonly json: unknown;
  readonly text: string;
};

/** A browser's view of the control plane: it keeps the session cookie the server sets, as a browser would. */
export class OwnerBrowser {
  readonly #url: string;
  cookie: string | undefined;

  constructor(url: string) {
    this.#url = url;
  }

  async logIn(password: string, next?: string): Promise<Answer> {
    return this.post("/api/login", { password, ...(next === undefined ? {} : { next }) });
  }

  get(path: string): Promise<Answer> {
    return this.request("GET", path);
  }

  post(path: string, body?: unknown): Promise<Answer> {
    return this.request("POST", path, body);
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Answer> {
    return this.send(method, path, {
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  /** A request exactly as given: its own headers and body text, as a page of another origin could send it. */
  async send(
    method: string,
    path: string,
    init: { headers?: Record<string, string>; body?: string } = {},
  ): Promise<Answer> {
    const response = await fetch(this.#url + path, {
      method,
      redirect: "manual",
      headers: { ...(this.cookie === undefined ? {} : { cookie: this.cookie }), ...init.headers },
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie !== null) {
      const pair = setCookie.split(";")[0] ?? "";
      this.cookie = pair.endsWith("=") ? undefined : pair;
    }
    const text = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: response.status, headers: response.headers, json, text };
  }

  /** Open a server-sent event stream, as an EventSource would. */
  async stream(path: string, lastEventId?: string): Promise<EventReader> {
    const response = await fetch(this.#url + path, {
      headers: {
        ...(this.cookie === undefined ? {} : { cookie: this.cookie }),
        ...(lastEventId === undefined ? {} : { "last-event-id": lastEventId }),
      },
    });
    if (response.status !== 200 || response.body === null)
      throw new Error(`stream ${path} answered ${response.status}: ${await response.text()}`);
    return new EventReader(response.body);
  }
}

export type ServerEvent = { event: string; data: unknown; id: string | undefined };

/** Reads a server-sent event stream as it arrives. */
export class EventReader {
  readonly events: ServerEvent[] = [];
  /** Resolves when the server closes the stream. */
  readonly ended: Promise<void>;
  readonly #body: ReadableStream<Uint8Array>;
  #changed: () => void = () => {};
  #done = false;

  constructor(body: ReadableStream<Uint8Array>) {
    this.#body = body;
    this.ended = this.#read();
    onTestFinished(() => this.cancel());
  }

  /** Wait until an event arrives that `matches`, and return it. Looks only at events from index `from` on (`events.length` at an earlier moment). Rejects if the stream ends first. */
  async next(
    matches: (event: ServerEvent) => boolean = () => true,
    from = 0,
  ): Promise<ServerEvent> {
    for (let seen = from; ;) {
      const found = this.events.slice(seen).find(matches);
      if (found !== undefined) return found;
      seen = this.events.length;
      if (this.#done)
        throw new Error(`the stream ended without it; got ${JSON.stringify(this.events)}`);
      await new Promise<void>((resolve) => (this.#changed = resolve));
    }
  }

  cancel(): void {
    if (!this.#done) void this.#body.cancel().catch(() => undefined);
  }

  async #read(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of this.#body) {
        buffer += decoder.decode(chunk, { stream: true });
        for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const fields = new Map<string, string>();
          for (const line of block.split("\n")) {
            if (line.startsWith(":")) continue;
            const colon = line.indexOf(": ");
            fields.set(line.slice(0, colon), line.slice(colon + 2));
          }
          const event = fields.get("event");
          if (event === undefined) continue;
          this.events.push({
            event,
            data: JSON.parse(fields.get("data") ?? "null"),
            id: fields.get("id"),
          });
          this.#changed();
        }
      }
    } catch {
      // Cancelled by the test.
    } finally {
      this.#done = true;
      this.#changed();
    }
  }
}
