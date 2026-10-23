import { createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PushNotice, PushSubscription } from "@mate/chat";
import {
  FakeClock,
  FakeNode,
  OwnerBrowser,
  temporaryDirectory,
  type Answer,
  type FakeNodeOptions,
  type ServerEvent,
} from "@mate/testkit";
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
          token?: string,
        ): Promise<string> {
          const pairingToken =
            token ??
            ((await owner.post("/api/admin/pairing-tokens")).json as { pairingToken: string })
              .pairingToken;
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
    pairingToken?: string,
  ): Promise<string>;
};

/** The owner's browser with the control plane's test password as the default. */
export class Browser extends OwnerBrowser {
  override logIn(password = PASSWORD, next?: string): Promise<Answer> {
    return super.logIn(password, next);
  }
}

export type { Answer, ServerEvent };

/** Let every callback already due run: timers, I/O and the promises they settle. */
export function settle(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
