// Fills a data directory through the public APIs of the Mate version it is run inside. `make-store-fixture.ts` copies
// this file into `apps/control-plane/` of a checkout of the released version and runs it there, so the stores it
// leaves are exactly what that version writes. It was written against v0.1.0-alpha.2; a later version whose APIs moved
// needs its own copy.
//
// usage: node --conditions=mate-source populate.ts <data-directory> <facts-file>
import { writeFileSync } from "node:fs";
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { openAdmin } from "@mate/admin";
import { ChatApp } from "@mate/chat";
import { systemClock } from "@mate/clock";
import { createNodeGateway } from "@mate/gateway";
import { FakeNode } from "@mate/testkit";
import { OwnerLogin } from "./src/login.ts";
import { vapidKeys } from "./src/push.ts";
import { openShellTables } from "./src/store.ts";

const [dataDirectory, factsFile] = process.argv.slice(2);
if (dataDirectory === undefined || factsFile === undefined)
  throw new Error("usage: populate.ts <data-directory> <facts-file>");

const OWNER_PASSWORD = "fixture owner password";
const API_KEY = "sk-fixture-not-a-real-key";
const AGENT_ONE = "11111111-1111-4111-8111-111111111111";
const AGENT_TWO = "22222222-2222-4222-8222-222222222222";
const HOME_NODE = "abcdef01-0000-4000-8000-000000000002";
const PUSH_ENDPOINT = "https://push.example.test/fixture-owner-device";

let requests = 0;
const rid = () => `fixture-${++requests}`;

// The shell's tables and the owner's login, as `startControlPlane` opens them on a first start.
const passwordFile = join(dataDirectory, "..", "initial-password");
writeFileSync(passwordFile, `${OWNER_PASSWORD}\n`, { mode: 0o600 });
const shell = openShellTables(dataDirectory);
const login = await OwnerLogin.open(shell, systemClock, passwordFile);
// A login session as a browser of that version holds it: a test proves the session still works after the upgrade.
const session = await login.logIn(OWNER_PASSWORD);
if (session.status !== "ok") throw new Error("the owner could not log in");
vapidKeys(shell);

const chat = new ChatApp(join(dataDirectory, "chat.sqlite"));
const owner = chat.ensureAccount({
  externalId: "owner",
  displayName: "Owner",
  handle: "owner",
  role: "owner",
});
chat.subscribePush(owner, {
  endpoint: PUSH_ENDPOINT,
  keys: { p256dh: "fixture-p256dh-key", auth: "fixture-auth" },
});
const gateway = createNodeGateway({
  dataDirectory,
  pairingTokenTtlMs: 100 * 365 * 24 * 60 * 60 * 1000,
});
const admin = await openAdmin({ dataDirectory, chat, owner, gateway, clock: systemClock });
admin.setCredentials("openai", { apiKey: API_KEY });

async function createPausedAgent() {
  await admin.createAgent({
    agentId: AGENT_ONE,
    nodeId: HOME_NODE,
    displayName: "Ada",
    handle: "ada",
    settings: { model: { provider: "openai", modelId: "gpt-4.1" } },
  });
  await admin.pauseAgent(AGENT_ONE);
}

const server = createServer();
server.on("upgrade", (request, socket, head) => gateway.handleUpgrade(request, socket, head));
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const gatewayUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/nodes/connect`;
const pairedNodes = [];
for (const nodeId of [HOME_NODE, "abcdef01-0000-4000-8000-000000000001"]) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const token = gateway.createPairingToken().pairingToken;
  const node = new FakeNode({
    gatewayUrl,
    nodeId,
    publicKey,
    pairingToken: token,
    sign: (nonce) =>
      sign(null, Buffer.from(nonce), createPrivateKey(privateKey)).toString("base64url"),
  });
  await node.connect();
  if (nodeId === HOME_NODE) await createPausedAgent();
  node.close();
  await node.closed();
  pairedNodes.push({
    nodeId,
    privateKey,
    publicKey,
    lastConnectedAt: gateway.status(nodeId).lastConnectedAt,
  });
}
await new Promise<void>((resolve) => server.close(() => resolve()));

const ada = chat.ensureAccount({ externalId: AGENT_ONE, displayName: "Ada", handle: "ada" });
const bo = chat.ensureAccount({ externalId: AGENT_TWO, displayName: "Bo", handle: "bo" });

const general = chat.createChannel(owner, {
  requestId: rid(),
  name: "general",
  visibility: "public",
});
const inGeneral = { conversation: general.conversationId };
chat.join(ada, { requestId: rid(), conversationId: general.conversationId });

// The freshness check holds a message until the sender has read the timeline, so a sender reads first.
type Timeline = { conversation: number } | { thread: number };
function post(account: number, timeline: Timeline, body: string, mentions: number[] = []) {
  chat.readUnread(account, timeline, { requestId: rid() });
  const sent = chat.send(account, timeline, { requestId: rid(), body, mentions });
  if (sent.status !== "sent") throw new Error(`"${body}" was held`);
  return sent;
}

const kickoff = post(owner, inGeneral, "Kickoff: ship the migration lever");
post(ada, inGeneral, "On it. I will draft the plan.");

// The owner has read this far; everything after is unread.
chat.readUnread(owner, inGeneral, { requestId: rid() });
post(ada, inGeneral, "Plan drafted, see the thread");
post(ada, inGeneral, "@owner please review", [owner]);
post(ada, { thread: kickoff.messageId }, "Thread: step one is the fixture");

// A task the owner created, then read past, and an Agent claimed after.
const taskMessage = post(owner, inGeneral, "Write the upgrade test");
const task = chat.createTask(owner, {
  requestId: rid(),
  messageId: taskMessage.messageId,
  title: "Upgrade test",
});
if (task.status !== "applied") throw new Error("the task was not created");
chat.readUnread(owner, inGeneral, { requestId: rid() });
chat.readUnread(ada, inGeneral, { requestId: rid() });
const claimed = chat.changeTask(ada, {
  requestId: rid(),
  taskId: task.task.taskId,
  change: { kind: "claim" },
});
if (claimed.status !== "applied") throw new Error("the task was not claimed");
post(ada, inGeneral, "Claimed it, starting now");
post(ada, inGeneral, "@owner the claim is done", [owner]);

// A DM the owner has not read, and one between the two Agents the owner can see.
const dm = chat.openDm(owner, { requestId: rid(), other: ada });
post(ada, { conversation: dm.conversationId }, "Hi owner, Ada here");
const agents = chat.openDm(ada, { requestId: rid(), other: bo });
post(ada, { conversation: agents.conversationId }, "Bo, can you review?");

const { pairingToken } = gateway.createPairingToken();

const summary = chat.unreadSummary(owner);
writeFileSync(
  factsFile,
  `${JSON.stringify(
    {
      ownerPassword: OWNER_PASSWORD,
      ownerSessionToken: session.session.token,
      openaiApiKey: API_KEY,
      pairingToken,
      pairedNodes,
      releasedAgent: { agentId: AGENT_ONE, nodeId: HOME_NODE },
      agentExternalIds: [AGENT_ONE, AGENT_TWO],
      pushEndpoint: PUSH_ENDPOINT,
      ownerUnread: {
        total: summary.total,
        mentions: summary.mentions,
        timelines: summary.timelines.length,
      },
    },
    null,
    2,
  )}\n`,
);

await admin.close();
gateway.close();
chat.close();
shell.close();
