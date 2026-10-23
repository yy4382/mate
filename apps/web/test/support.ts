import { createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  chromium,
  type Browser as ChromiumBrowser,
  type BrowserContext,
  type Page,
} from "playwright";
import { FakeClock, FakeNode, ScriptedProvider, temporaryDirectory } from "@mate/testkit";
import { build } from "vite";
import { onTestFinished } from "vitest";
import { startControlPlane, type ControlPlane } from "../../control-plane/src/control-plane.ts";

export const PASSWORD = "correct horse battery staple";
export const DAY_MS = 24 * 60 * 60 * 1000;

const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let built: Promise<string> | undefined;

/** The frontend, built once by this worker with Vite into a temporary directory the control plane serves. */
export function webDirectory(): Promise<string> {
  built ??= (async () => {
    const outDir = mkdtempSync(join(tmpdir(), "mate-web-"));
    process.once("exit", () => rmSync(outDir, { recursive: true, force: true }));
    await build({
      root: appDirectory,
      configFile: join(appDirectory, "vite.config.ts"),
      logLevel: "silent",
      build: { outDir, emptyOutDir: true },
    });
    return outDir;
  })();
  return built;
}

let launched: Promise<ChromiumBrowser> | undefined;

function chromiumBrowser(): Promise<ChromiumBrowser> {
  launched ??= chromium.launch().then((browser) => {
    process.once("exit", () => void browser.close());
    return browser;
  });
  return launched;
}

/** The owner as an HTTP client: arranges state on the control plane that a test then looks for in the page. */
export class Owner {
  readonly #url: string;
  #cookie: string | undefined;

  constructor(url: string) {
    this.#url = url;
  }

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(this.#url + path, {
      method,
      headers: {
        ...(this.#cookie === undefined ? {} : { cookie: this.#cookie }),
        ...(method === "GET" ? {} : { "content-type": "application/json" }),
      },
      ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie !== null) this.#cookie = setCookie.split(";")[0];
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${text}`);
    return (text === "" ? undefined : JSON.parse(text)) as T;
  }

  get = <T>(path: string) => this.request<T>("GET", path);
  post = <T = unknown>(path: string, body?: unknown) => this.request<T>("POST", path, body);
  put = <T = unknown>(path: string, body?: unknown) => this.request<T>("PUT", path, body);

  async logIn(): Promise<this> {
    await this.post("/api/login", { password: PASSWORD });
    return this;
  }

  /** A channel, made by the owner. */
  async channel(name: string, visibility: "public" | "private" = "public"): Promise<number> {
    const channel = await this.post<{ conversationId: number }>("/api/chat/channels", {
      requestId: randomUUID(),
      name,
      visibility,
    });
    return channel.conversationId;
  }

  /** A top-level message by the owner; resolves to its seq and id. */
  async say(
    conversation: number,
    body: string,
    thread?: number,
  ): Promise<{ seq: number; messageId: number }> {
    return this.post("/api/chat/messages", {
      timeline: thread === undefined ? { conversation } : { thread },
      requestId: randomUUID(),
      body,
    });
  }
}

export type TestAgent = {
  readonly agentId: string;
  readonly accountId: number;
  readonly nodeId: string;
  readonly provider: ScriptedProvider;
  /** Have the Agent post `body` in `conversation` (it must be a member): the owner asks in a DM, the script answers. */
  say(conversation: number, body: string): Promise<void>;
};

export type Site = {
  readonly url: string;
  /** The address a browser uses: `localhost`, which browsers treat as secure, so the `Secure` cookie is kept. */
  readonly origin: string;
  readonly clock: FakeClock;
  readonly owner: Owner;
  /** Pair a fake node through the control plane's own HTTP server and WebSocket. */
  pairNode(
    options?: ConstructorParameters<typeof FakeNode>[0] extends infer O ? Partial<O> : never,
  ): Promise<string>;
  /** A scripted model provider whose address and key the owner has stored through the API. */
  provider(): Promise<ScriptedProvider>;
  /** An Agent on a paired node, whose model is the scripted provider. */
  agent(handle: string): Promise<TestAgent>;
  close(): Promise<void>;
};

/** A control plane serving the built frontend, on a temporary data directory and a fake clock. */
export async function startSite(): Promise<Site> {
  const data = join(temporaryDirectory(), "data");
  const passwordFile = join(temporaryDirectory(), "password");
  writeFileSync(passwordFile, `${PASSWORD}\n`, { mode: 0o600 });
  const clock = new FakeClock(Date.UTC(2026, 0, 1, 9, 30, 0));
  const plane: ControlPlane = await startControlPlane({
    dataDirectory: data,
    initialPasswordFile: passwordFile,
    webDirectory: await webDirectory(),
    clock,
    push: async () => 201,
  });
  const nodes: FakeNode[] = [];
  onTestFinished(async () => {
    for (const node of nodes) node.terminate();
    await plane.close();
  });
  const owner = await new Owner(plane.url).logIn();
  const port = new URL(plane.url).port;
  let provider: ScriptedProvider | undefined;
  let node: string | undefined;
  const site: Site = {
    url: plane.url,
    origin: `http://localhost:${port}`,
    clock,
    owner,
    close: () => plane.close(),
    async provider() {
      if (provider !== undefined) return provider;
      const started = await ScriptedProvider.start();
      provider = started;
      onTestFinished(() => started.close());
      await owner.put("/api/admin/providers/openai/credentials", {
        apiKey: "sk-test-00000001",
        baseUrl: started.baseUrl,
      });
      return started;
    },
    async agent(handle) {
      const scripted = await site.provider();
      node ??= await site.pairNode();
      const displayName = handle.slice(0, 1).toUpperCase() + handle.slice(1);
      const { agentId } = await owner.post<{ agentId: string }>("/api/admin/agents", {
        nodeId: node,
        displayName,
        handle,
        settings: { model: { provider: "openai", modelId: "gpt-4.1" } },
      });
      const { accounts } = await owner.get<{ accounts: { accountId: number; handle: string }[] }>(
        "/api/chat/snapshot",
      );
      const accountId = accounts.find((account) => account.handle === handle)?.accountId ?? 0;
      const dm = await owner.post<{ conversationId: number }>("/api/chat/dms", {
        requestId: randomUUID(),
        other: accountId,
      });
      let turn = 0;
      return {
        agentId,
        accountId,
        nodeId: node,
        provider: scripted,
        async say(conversation, body) {
          turn += 1;
          const timeline = { conversation };
          scripted
            .step(`${handle}-read-${turn}`, (request) => {
              request.call([{ name: "chat_read_unread", arguments: { timeline } }]);
            })
            .step(`${handle}-send-${turn}`, (request) => {
              request.call([{ name: "chat_send", arguments: { timeline, body } }]);
            })
            .step(`${handle}-done-${turn}`, (request) => request.text("done"));
          await owner.say(dm.conversationId, `go ${turn}`);
          for (let waited = 0; waited < 15_000; waited += 100) {
            const seen = await owner.get<{ kind: string; body?: string }[]>(
              `/api/chat/history?conversation=${conversation}&limit=20`,
            );
            if (seen.some((entry) => entry.body === body)) return;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          throw new Error(`${handle} never said ${body}`);
        },
      };
    },
    async pairNode(overrides = {}) {
      const { pairingToken } = await owner.post<{ pairingToken: string }>(
        "/api/admin/pairing-tokens",
      );
      const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      });
      const nodeId = randomUUID();
      const fake = new FakeNode({
        gatewayUrl: `${plane.url.replace("http", "ws")}/api/nodes/connect`,
        nodeId,
        publicKey,
        pairingToken,
        sign: (nonce) =>
          sign(null, Buffer.from(nonce), createPrivateKey(privateKey)).toString("base64url"),
        ...overrides,
      });
      nodes.push(fake);
      await fake.connect();
      return nodeId;
    },
  };
  return site;
}

/** A fresh browser context (no cookies) on `site`; closed when the test finishes. Avatar images from DiceBear are answered locally, unless screenshots are being taken (`MATE_SCREENS`). */
export async function newPage(
  site: Site,
  viewport: { width: number; height: number } = { width: 1280, height: 800 },
): Promise<{ page: Page; context: BrowserContext }> {
  const context = await (await chromiumBrowser()).newContext({ viewport });
  onTestFinished(() => context.close());
  if (process.env.MATE_SCREENS === undefined)
    await context.route("https://api.dicebear.com/**", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>',
      }),
    );
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  return { page, context };
}

/** Log in through the login page, as the owner would, and wait for the app. */
export async function signIn(page: Page, site: Site, next?: string): Promise<void> {
  await page.goto(
    `${site.origin}/login${next === undefined ? "" : `?next=${encodeURIComponent(next)}`}`,
  );
  await page.getByLabel("密码").fill(PASSWORD);
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForURL(/\/app/);
}

/** Open the app logged in at `path`. */
export async function openApp(
  site: Site,
  path = "/app",
  viewport?: { width: number; height: number },
) {
  const { page, context } = await newPage(site, viewport);
  await signIn(page, site, path);
  await page.getByRole("navigation", { name: "主导航" }).waitFor();
  return { page, context };
}
