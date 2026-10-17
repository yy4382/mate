import { createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PushNotice, PushSubscription } from "@mate/chat";
import { FakeClock, FakeNode, temporaryDirectory, type FakeNodeOptions } from "@mate/testkit";
import { onTestFinished } from "vitest";
import { startControlPlane, type ControlPlane } from "../src/control-plane.ts";

export const PASSWORD = "correct horse battery staple";
export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A fake clock that also tells the test when something has started waiting on it. A login check that has to queue
 * sleeps on the clock for its deadline in the same step that it joins the line, so a new sleep is how a test learns,
 * without waiting in real time, that a request has reached the queue.
 */
export class ObservedClock extends FakeClock {
  sleeps = 0;
  #watchers: (() => void)[] = [];

  override sleep(ms: number | undefined, signal: AbortSignal): Promise<void> {
    const slept = super.sleep(ms, signal);
    this.sleeps++;
    for (const watcher of this.#watchers.splice(0)) watcher();
    return slept;
  }

  /** Resolves once `sleeps` has reached `count`. */
  async sleepsReached(count: number): Promise<void> {
    while (this.sleeps < count) await new Promise<void>((resolve) => this.#watchers.push(resolve));
  }
}

export type Push = { subscription: PushSubscription; notice: PushNotice };

/**
 * A data directory, an initial password file holding `PASSWORD`, a fake clock and a push service that records every
 * push and answers 201. `start()` starts the control plane on them, as the entry point would; every control plane and
 * node started here is closed after the test.
 */
export function environment(options: { webDirectory?: string } = {}) {
  const data = join(temporaryDirectory(), "data");
  const passwordFile = join(temporaryDirectory(), "password");
  writeFileSync(passwordFile, `${PASSWORD}\n`, { mode: 0o600 });
  const clock = new ObservedClock(Date.UTC(2026, 0, 1, 9, 30, 0));
  const pushes: Push[] = [];
  const running = new Set<ControlPlane>();
  const nodes: FakeNode[] = [];
  onTestFinished(async () => {
    for (const node of nodes) node.terminate();
    for (const plane of running) await plane.close();
  });

  return {
    data,
    passwordFile,
    clock,
    pushes,
    async start(overrides: { initialPasswordFile?: string | undefined } = {}): Promise<Site> {
      const plane = await startControlPlane({
        dataDirectory: data,
        initialPasswordFile: passwordFile,
        clock,
        push: async (subscription, notice) => {
          pushes.push({ subscription, notice });
          return 201;
        },
        ...options,
        ...overrides,
      });
      running.add(plane);
      return {
        url: plane.url,
        browser: () => new Browser(plane.url),
        async close() {
          running.delete(plane);
          await plane.close();
        },
        /** Pair a fake node with a token the owner made, connected through the control plane's own HTTP server. */
        async pairNode(
          owner: Browser,
          behaviour: Pick<FakeNodeOptions, "onBrowse" | "onPrepareWorkspace"> = {},
        ): Promise<string> {
          const { pairingToken } = (await owner.post("/api/admin/pairing-tokens")).json as {
            pairingToken: string;
          };
          const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
            privateKeyEncoding: { type: "pkcs8", format: "pem" },
            publicKeyEncoding: { type: "spki", format: "pem" },
          });
          const nodeId = randomUUID();
          const node = new FakeNode({
            gatewayUrl: `${plane.url.replace("http", "ws")}/api/nodes/connect`,
            nodeId,
            publicKey,
            pairingToken,
            ...behaviour,
            sign: (nonce) =>
              sign(null, Buffer.from(nonce), createPrivateKey(privateKey)).toString("base64url"),
          });
          nodes.push(node);
          await node.connect();
          return nodeId;
        },
      };
    },
  };
}

export type Site = {
  readonly url: string;
  /** A new browser with no cookies. */
  browser(): Browser;
  close(): Promise<void>;
  pairNode(
    owner: Browser,
    behaviour?: Pick<FakeNodeOptions, "onBrowse" | "onPrepareWorkspace">,
  ): Promise<string>;
};

export type Answer = {
  readonly status: number;
  readonly headers: Headers;
  readonly json: unknown;
  readonly text: string;
};

/** A browser's view of the control plane: it keeps the session cookie the server sets, as a browser would. */
export class Browser {
  readonly #url: string;
  cookie: string | undefined;

  constructor(url: string) {
    this.#url = url;
  }

  async logIn(password = PASSWORD, next?: string): Promise<Answer> {
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

  /** Wait until an event arrives that `matches`, and return it. Rejects if the stream ends first. */
  async next(matches: (event: ServerEvent) => boolean = () => true): Promise<ServerEvent> {
    for (let seen = 0; ;) {
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

/** Let every callback already due run: timers, I/O and the promises they settle. */
export function settle(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
