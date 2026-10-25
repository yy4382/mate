import { createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { ChatApp } from "@mate/chat";
import { createNodeGateway } from "@mate/gateway";
import type {
  GatewayBrowse,
  GatewayRunTool,
  NodeBrowseOutcome,
  NodeSystem,
  ToolResult,
} from "@mate/node-protocol";
import { FakeClock, FakeNode, ScriptedProvider, temporaryDirectory } from "@mate/testkit";
import { onTestFinished } from "vitest";
import { openAdmin, type Admin, type AgentEvent } from "../src/index.ts";

export const settings = { model: { provider: "openai", modelId: "gpt-4.1" } } as const;

export type NodeIdentity = { nodeId: string; publicKey: string; sign: (nonce: string) => string };

export function newIdentity(): NodeIdentity {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return {
    nodeId: randomUUID(),
    publicKey,
    sign: (nonce) =>
      sign(null, Buffer.from(nonce, "utf8"), createPrivateKey(privateKey)).toString("base64url"),
  };
}

type Answer = { outputs: string[]; result: ToolResult };

/** A fake node paired with the real gateway, which records what it was asked and answers as the test says. */
export type TestNode = {
  readonly nodeId: string;
  readonly node: FakeNode;
  /** The Agents whose workspace it was asked to prepare. */
  readonly prepared: string[];
  answerPrepare: (agentId: string) => Promise<void>;
  readonly calls: GatewayRunTool[];
  /** Request IDs of the calls the gateway told it to stop. */
  readonly stopped: string[];
  /** How the next tool calls are answered; by default at once with "ok". */
  answer: (call: GatewayRunTool) => Promise<Answer>;
  readonly browses: GatewayBrowse[];
  /** How the next browses are answered; by default with an empty directory. */
  answerBrowse: (browse: GatewayBrowse) => Promise<NodeBrowseOutcome>;
};

export function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: false };
}

/** Every JSON text of the events, so a test can look for what the owner would see. */
export function rendered(events: readonly AgentEvent[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n");
}

export type Environment = Awaited<ReturnType<typeof environment>>;

/**
 * Everything around the admin module: a data directory, the real chat app with the owner and #general, a scripted
 * provider, the real node gateway on a local HTTP server, and a fake clock. Admins opened here are closed after the
 * test, before the rest.
 */
export async function environment(data = temporaryDirectory()) {
  const clock = new FakeClock(Date.UTC(2026, 0, 1, 9, 30, 5));
  const chat = new ChatApp(join(data, "chat.sqlite"));
  const provider = await ScriptedProvider.start();
  const gateway = createNodeGateway({ dataDirectory: data, clock });
  const server = createServer();
  server.on("upgrade", (req, socket, head) => gateway.handleUpgrade(req, socket, head));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const gatewayUrl = `ws://127.0.0.1:${port}/api/nodes/connect`;
  const reports: { agentId: string; error: unknown }[] = [];
  const admins: Admin[] = [];
  const nodes: FakeNode[] = [];
  onTestFinished(async () => {
    await Promise.all(admins.map((admin) => admin.close().catch(() => undefined)));
    for (const node of nodes) node.terminate();
    gateway.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await provider.close();
    chat.close();
  });
  const owner = chat.ensureAccount({
    externalId: "owner",
    displayName: "Owner",
    handle: "owner",
    kind: "human",
  });
  const general =
    chat.listConversations(owner).find((conversation) => conversation.name === "general")
      ?.conversationId ??
    chat.createChannel(owner, {
      requestId: "setup:general",
      name: "general",
      visibility: "public",
    }).conversationId;
  let posts = 0;

  return {
    data,
    chat,
    owner,
    general,
    provider,
    gateway,
    gatewayUrl,
    clock,
    reports,
    /** Open the admin module on the data directory, as a control plane start would. */
    async open(): Promise<Admin> {
      const admin = await openAdmin({
        dataDirectory: data,
        chat,
        gateway,
        clock,
        report: (error, agentId) => reports.push({ agentId, error }),
      });
      admins.push(admin);
      return admin;
    },
    /** Give `admin` an OpenAI key whose requests reach the scripted provider. */
    useScriptedProvider(admin: Admin, apiKey = "sk-test-0001") {
      admin.setCredentials("openai", { apiKey, baseUrl: provider.baseUrl });
    },
    /** Pair a new fake node with a token from `admin`, and wait until it is connected. */
    async pairNode(admin: Admin, system?: NodeSystem): Promise<TestNode> {
      const identity = newIdentity();
      const prepared: string[] = [];
      const calls: GatewayRunTool[] = [];
      const stopped: string[] = [];
      const browses: GatewayBrowse[] = [];
      const node = new FakeNode({
        gatewayUrl,
        ...identity,
        pairingToken: admin.createPairingToken().pairingToken,
        ...(system === undefined ? {} : { system }),
        onPrepareWorkspace: async (agentId) => {
          prepared.push(agentId);
          await test.answerPrepare(agentId);
        },
        onRunTool: (call) => {
          calls.push(call);
          return test.answer(call);
        },
        onStopTool: (requestId) => stopped.push(requestId),
        onBrowse: (browse) => {
          browses.push(browse);
          return test.answerBrowse(browse);
        },
      });
      nodes.push(node);
      const test: TestNode = {
        nodeId: identity.nodeId,
        node,
        prepared,
        answerPrepare: async () => {},
        calls,
        stopped,
        answer: async () => ({ outputs: [], result: ok("ok") }),
        browses,
        answerBrowse: async ({ path }) => ({
          ok: true,
          listing: { kind: "directory", path, entries: [], truncated: false },
        }),
      };
      await node.connect();
      return test;
    },
    /** Create an Agent on `nodeId` and have the owner invite it to #general. Returns its ID and chat account. */
    async hire(
      admin: Admin,
      nodeId: string,
      names = { displayName: "Richard", handle: "richard" },
    ) {
      const agentId = await admin.createAgent({ nodeId, ...names, settings });
      const account = chat.findAccount(agentId);
      if (account === undefined) throw new Error("the created Agent has no account");
      chat.invite(owner, {
        requestId: `invite:${agentId}`,
        conversationId: general,
        invitee: account,
      });
      return { agentId, account };
    },
    /** The owner posts in #general, as the web client does: without the freshness check. */
    post(body: string, mentions: number[] = []) {
      return chat.send(
        owner,
        { conversation: general },
        { requestId: `owner:${++posts}`, body, freshness: false, mentions },
      );
    },
  };
}
