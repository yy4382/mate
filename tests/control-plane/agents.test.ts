import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createControlPlaneApp } from "../../src/control-plane/http.js";
import { OwnerAuth } from "../../src/control-plane/owner-auth.js";
import {
  controlPlaneMigrations,
  controlPlaneSchemaV4,
  controlPlaneSchemaV11,
  controlPlaneSchemaV8,
} from "../../src/control-plane/schema.js";
import { newAgentRequestSchema } from "../../src/control-plane/agents/contracts.js";
import type { NodeSocket } from "../../src/control-plane/nodes/directory.js";

const ownerPassword = "agent-creation-owner-password";
const fixtures: Array<{ app: ReturnType<typeof createControlPlaneApp>; directory: string }> = [];

afterEach(() => {
  for (const { app, directory } of fixtures.splice(0)) {
    app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "mate-agent-creation-"));
  chmodSync(directory, 0o700);
  const passwordFile = join(directory, "owner-password");
  writeFileSync(passwordFile, `${ownerPassword}\n`, { mode: 0o600 });
  const app = createControlPlaneApp({
    dataDir: join(directory, "control-plane"),
    passwordFile,
  });
  fixtures.push({ app, directory });
  return app;
}

async function login(app: ReturnType<typeof createControlPlaneApp>): Promise<string> {
  const response = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: ownerPassword }),
  });
  expect(response.status).toBe(204);
  return response.headers.get("set-cookie")!.split(";", 1)[0]!;
}

class FakeNodeSocket implements NodeSocket {
  readonly sent: string[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  terminate(): void {
    this.closed = true;
  }
}

async function pairNode(
  app: ReturnType<typeof createControlPlaneApp>,
  cookie: string,
): Promise<{ id: string; socket: FakeNodeSocket }> {
  const tokenResponse = await app.request("/api/owner/nodes/pairing-tokens", {
    method: "POST",
    headers: { cookie },
  });
  const { pairingToken } = (await tokenResponse.json()) as { pairingToken: string };
  const socket = new FakeNodeSocket();
  app.nodes.open(socket);
  const challenge = JSON.parse(socket.sent[0]!) as { nonce: string };
  const id = randomUUID();
  const keyPair = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.pair",
      requestId: randomUUID(),
      nodeId: id,
      pairingToken,
      publicKey: keyPair.publicKey,
      signature: sign(null, Buffer.from(challenge.nonce), keyPair.privateKey).toString("base64url"),
    }),
  );
  return { id, socket };
}

it("keeps an offline-node Agent form unsubmitted", async () => {
  const app = setup();
  const cookie = await login(app);
  const input = {
    id: "ed1e60c8-bdda-4f46-a857-bbd542f82640",
    name: "Research partner",
    role: "Researches questions and reports evidence",
    description: "A private colleague for research work.",
    nodeId: "c5342142-9cf5-4b22-86f3-bdc46bb471f2",
    model: { provider: "openai", id: "gpt-4.1" },
  };

  const response = await app.request("/api/owner/agents", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(input),
  });

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "所选节点当前离线，Agent 资料尚未提交。" });
  const list = await app.request("/api/owner/agents", { headers: { cookie } });
  expect(list.status).toBe(200);
  expect(await list.json()).toEqual({ agents: [] });
});

it("rejects a model outside the provider registry before persisting an Agent", async () => {
  const app = setup();
  const cookie = await login(app);
  const { id: nodeId, socket } = await pairNode(app, cookie);
  const input = {
    id: randomUUID(),
    name: "Invalid model partner",
    role: "Uses an available model",
    description: "A model registry validation fixture.",
    nodeId,
    model: { provider: "openai", id: "gpt-4.1-typo" },
  };
  const creation = app.request("/api/owner/agents", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const provision = socket.sent
    .map((text) => JSON.parse(text) as Record<string, unknown>)
    .find((message) => message.type === "control.agent.provision");
  if (provision) {
    await app.nodes.receive(
      socket,
      JSON.stringify({
        type: "node.agent.provision.result",
        requestId: provision.requestId,
        agentId: input.id,
        ok: false,
        code: "unsupported_host",
        message: "Synthetic provisioning failure.",
      }),
    );
  }
  const response = await creation;
  expect(response.status).toBe(400);
  expect(app.agents.list()).toHaveLength(0);
  expect(provision).toBeUndefined();
});

it("rejects credential fields outside the Agent creation contract", () => {
  const parsed = newAgentRequestSchema.safeParse({
    id: "ed1e60c8-bdda-4f46-a857-bbd542f82640",
    name: "Research partner",
    role: "Researches questions and reports evidence",
    description: "A private colleague for research work.",
    nodeId: "c5342142-9cf5-4b22-86f3-bdc46bb471f2",
    model: { provider: "openai", id: "gpt-4.1" },
    apiKeyEnv: "OPENAI_API_KEY",
  });
  expect(parsed.success).toBe(false);
});

it("migrates paired-node control-plane data and enables Agent foreign keys", () => {
  const directory = mkdtempSync(join(tmpdir(), "mate-agent-migration-"));
  const databasePath = join(directory, "control-plane.sqlite");
  const old = new Database(databasePath);
  old.exec(controlPlaneSchemaV4);
  old
    .prepare("INSERT INTO nodes(id,public_key,paired_at) VALUES(?,?,?)")
    .run("c5342142-9cf5-4b22-86f3-bdc46bb471f2", "fixture-key", 10);
  old.pragma("application_id = 1296257100");
  old.pragma("user_version = 4");
  old.close();

  const auth = new OwnerAuth({ dataDir: directory });
  try {
    expect(auth.db.pragma("user_version", { simple: true })).toBe(14);
    expect(auth.db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(auth.db.prepare("SELECT id FROM nodes").get()).toEqual({
      id: "c5342142-9cf5-4b22-86f3-bdc46bb471f2",
    });
    expect(
      auth.db.prepare("SELECT name FROM sqlite_master WHERE name='owner_agents'").get(),
    ).toEqual({
      name: "owner_agents",
    });
    expect(controlPlaneMigrations.map((migration) => migration.fromRevision)).toEqual([
      3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
  } finally {
    auth.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("backfills committed conversation tool actions into recoverable journal history", () => {
  const directory = mkdtempSync(join(tmpdir(), "mate-agent-action-history-migration-")),
    databasePath = join(directory, "control-plane.sqlite"),
    old = new Database(databasePath);
  old.exec(controlPlaneSchemaV11);
  old.exec(`
    INSERT INTO nodes(id,public_key,paired_at) VALUES('node','synthetic-public-key',1);
    INSERT INTO owner_channels(id,name,description,visibility,created_at,updated_at)
      VALUES('room','Research','Synthetic migration fixture','private',1,1);
    INSERT INTO owner_channel_memberships(channel_id,principal_kind,principal_id,active,joined_at)
      VALUES('room','human','owner',1,1),('room','agent','agent',1,1);
    INSERT INTO owner_agents(
      id,node_id,name,role,description,provider,model_id,request_json,request_hash,
      provision_request_id,status,stage,linux_username,uid,gid,home,created_at,updated_at,model_ready
    ) VALUES(
      'agent','node','Partner','Replies','Migration fixture','openai','gpt-4.1','{}',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','provision',
      'waiting_credentials','complete','mate_agent',23001,23001,'/var/lib/mate/agents/agent',1,1,0
    );
    INSERT INTO owner_agent_sessions(id,agent_id,created_at,verified_at)
      VALUES('session','agent',1,1);
    INSERT INTO owner_messages(id,channel_id,order_seq,text,author_kind,author_id,created_at)
      VALUES('sent-message','room',1,'Persisted action text','agent','agent',2);
    INSERT INTO owner_agent_session_journal(
      session_id,agent_id,channel_id,message_id,role,text,created_at
    ) VALUES('session','agent','room','sent-message','assistant','Persisted action text',2);
  `);
  old
    .prepare(
      `INSERT INTO owner_agent_tool_actions(
         session_id,action_id,agent_id,operation,request_hash,result_json,created_at
       ) VALUES(?,?,?,?,?,?,?)`,
    )
    .run(
      "session",
      "legacy-action",
      "agent",
      "messages.send",
      "b".repeat(64),
      JSON.stringify({ id: "sent-message", channelId: "room", text: "Persisted action text" }),
      2,
    );
  old.pragma("application_id = 1296257100");
  old.pragma("user_version = 11");
  old.close();

  const auth = new OwnerAuth({ dataDir: directory });
  try {
    expect(auth.db.pragma("user_version", { simple: true })).toBe(14);
    expect(
      auth.db
        .prepare(
          `SELECT message_id,tool_action_id FROM owner_agent_session_journal
           WHERE message_id='sent-message'`,
        )
        .get(),
    ).toEqual({ message_id: "sent-message", tool_action_id: "legacy-action" });
    const receipt = auth.db
      .prepare(
        `SELECT text,tool_action_id FROM owner_agent_session_journal
         WHERE message_id IS NULL AND tool_action_id='legacy-action'`,
      )
      .get() as { text: string; tool_action_id: string } | undefined;
    expect(receipt?.tool_action_id).toBe("legacy-action");
    expect(receipt?.text).toContain('messages.send {"id":"sent-message","channelId":"room"}');
    expect(receipt?.text).not.toContain("Persisted action text");
  } finally {
    auth.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("backfills pending channel deliveries into the shared session journal when upgrading revision 8", () => {
  const directory = mkdtempSync(join(tmpdir(), "mate-agent-batch-migration-")),
    databasePath = join(directory, "control-plane.sqlite");
  const old = new Database(databasePath);
  old.exec(controlPlaneSchemaV8);
  old.exec(`
    INSERT INTO nodes(id,public_key,paired_at) VALUES('node','synthetic-public-key',1);
    INSERT INTO owner_channels(id,name,description,visibility,created_at,updated_at)
      VALUES('room','Research','Synthetic migration fixture','private',1,1),
            ('room-2','Research 2','Second migration fixture','private',1,1);
    INSERT INTO owner_channel_memberships(channel_id,principal_kind,principal_id,active,joined_at)
      VALUES('room','human','owner',1,1),('room','agent','agent',1,1),
            ('room-2','human','owner',1,1),('room-2','agent','agent',1,1);
    INSERT INTO owner_agents(
      id,node_id,name,role,description,provider,model_id,request_json,request_hash,
      provision_request_id,status,stage,linux_username,uid,gid,home,created_at,updated_at,model_ready
    ) VALUES(
      'agent','node','Partner','Replies','Migration fixture','openai','gpt-4.1','{}',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','provision',
      'waiting_credentials','complete','mate_agent',23001,23001,'/var/lib/mate/agents/agent',1,1,0
    );
    INSERT INTO owner_agent_sessions(id,agent_id,created_at,verified_at)
      VALUES('session','agent',1,1);
    INSERT INTO owner_messages(id,channel_id,order_seq,text,author_kind,author_id,created_at)
      VALUES('message','room',1,'旧版频道排队输入','human','owner',1),
            ('message-2','room-2',1,'旧版第二频道排队输入','human','owner',2);
    INSERT INTO owner_message_deliveries(id,message_id,channel_id,recipient_kind,recipient_id,state,created_at)
      VALUES('delivery','message','room','agent','agent','pending',1);
    INSERT INTO owner_message_deliveries(id,message_id,channel_id,recipient_kind,recipient_id,state,created_at)
      VALUES('delivery-2','message-2','room-2','agent','agent','pending',2);
  `);
  old.pragma("application_id = 1296257100");
  old.pragma("user_version = 8");
  old.close();

  const auth = new OwnerAuth({ dataDir: directory });
  try {
    expect(auth.db.pragma("user_version", { simple: true })).toBe(14);
    expect(
      auth.db
        .prepare(
          "SELECT role,text FROM owner_agent_session_journal WHERE agent_id='agent' ORDER BY seq",
        )
        .all(),
    ).toEqual([
      { role: "user", text: "旧版频道排队输入" },
      { role: "user", text: "旧版第二频道排队输入" },
    ]);
    expect(
      auth.db.prepare("SELECT input_end_seq FROM owner_agent_runs WHERE id='missing'").get(),
    ).toBeUndefined();
    expect(
      auth.db
        .prepare("SELECT context_history_end_seq FROM owner_agent_runs WHERE id='missing'")
        .get(),
    ).toBeUndefined();
  } finally {
    auth.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("sends only the bounded Agent provisioning operation to the selected online node", async () => {
  const app = setup();
  const cookie = await login(app);
  const { id: nodeId, socket } = await pairNode(app, cookie);
  const agentId = "ed1e60c8-bdda-4f46-a857-bbd542f82640";
  const requestId = randomUUID();
  const stages: string[] = [];
  const completed = app.nodes.provisionAgent(nodeId, requestId, agentId, (stage) =>
    stages.push(stage),
  );
  const command = JSON.parse(socket.sent.at(-1)!) as Record<string, unknown>;

  expect(command).toEqual({
    type: "control.agent.provision",
    requestId,
    agentId,
  });

  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.provision.progress",
      requestId,
      agentId,
      stage: "preparing_home",
    }),
  );
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.provision.result",
      requestId,
      agentId,
      ok: true,
      identity: {
        username: "mate_123456789012345678901234567",
        uid: 23001,
        gid: 23001,
        home: "/var/lib/mate/agents/ed1e60c8-bdda-4f46-a857-bbd542f82640",
      },
    }),
  );

  await expect(completed).resolves.toMatchObject({
    ok: true,
    identity: { uid: 23001, gid: 23001 },
  });
  expect(stages).toEqual(["preparing_home"]);
  expect(socket.sent.join("\n")).not.toContain("useradd");
});

it("persists a stable Agent session, verifies provisioning, then queues its initial-channel messages", async () => {
  const app = setup();
  const cookie = await login(app);
  const { id: nodeId, socket } = await pairNode(app, cookie);
  const channelResponse = await app.request("/api/owner/channels", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "Research", description: "Research work", visibility: "private" }),
  });
  expect(channelResponse.status).toBe(201);
  const { id: channelId } = (await channelResponse.json()) as { id: string };
  const input = {
    id: "ed1e60c8-bdda-4f46-a857-bbd542f82640",
    name: "Research partner",
    role: "Researches questions and reports evidence",
    description: "A private colleague for research work.",
    nodeId,
    model: { provider: "openai", id: "gpt-4.1" },
    initialChannelId: channelId,
  };

  const creation = app.request("/api/owner/agents", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const command = JSON.parse(socket.sent.at(-1)!) as {
    type: string;
    requestId: string;
    agentId: string;
  };
  expect(command).toEqual({
    type: "control.agent.provision",
    requestId: expect.any(String),
    agentId: input.id,
  });
  expect(app.chat.inviteAgentToChannel(channelId, input.id)).toBe(false);
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.provision.progress",
      requestId: command.requestId,
      agentId: input.id,
      stage: "preparing_home",
    }),
  );
  const progressResponse = await app.request("/api/owner/agents", { headers: { cookie } });
  const progress = (await progressResponse.json()) as { agents: Array<{ stage: string }> };
  expect(progress.agents[0]?.stage).toBe("preparing_home");
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.provision.result",
      requestId: command.requestId,
      agentId: input.id,
      ok: true,
      identity: {
        username: "mate_ed1e60c8bdda4f46a857bbd542f",
        uid: 23001,
        gid: 23001,
        home: `/var/lib/mate/agents/${input.id}`,
      },
    }),
  );

  const response = await creation;
  expect(response.status).toBe(201);
  const { agent } = (await response.json()) as {
    agent: {
      id: string;
      sessionId: string;
      status: string;
      stage: string;
      model: { provider: string; id: string };
      linuxIdentity: { username: string; uid: number; gid: number; home: string };
    };
  };
  expect(agent).toMatchObject({
    id: input.id,
    status: "waiting_credentials",
    stage: "complete",
    model: input.model,
    linuxIdentity: {
      username: "mate_ed1e60c8bdda4f46a857bbd542f",
      uid: 23001,
      gid: 23001,
      home: `/var/lib/mate/agents/${input.id}`,
    },
  });
  expect(app.chat.inviteAgentToChannel(channelId, input.id)).toBe(true);
  const sentCount = socket.sent.length;
  const repeat = await app.request("/api/owner/agents", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  expect(repeat.status).toBe(200);
  expect(((await repeat.json()) as { agent: { sessionId: string } }).agent.sessionId).toBe(
    agent.sessionId,
  );
  expect(socket.sent).toHaveLength(sentCount);

  app.chat.createMessage(channelId, "A queued first message");
  expect(app.chat.listPendingDeliveries("agent", input.id).deliveries).toHaveLength(1);
  expect(app.chat.listAgentSessionJournal(input.id, 0, 10).messages).toMatchObject([
    { role: "user", text: "A queued first message" },
  ]);
});

it("finds an online Agent beyond more than one page of offline deliveries", async () => {
  const app = setup();
  const cookie = await login(app);
  const offlineNode = await pairNode(app, cookie),
    onlineNode = await pairNode(app, cookie);
  app.nodes.close(offlineNode.socket);

  for (let index = 0; index < 105; index++) {
    const id = randomUUID();
    app.agents.prepare({
      id,
      nodeId: offlineNode.id,
      name: `Offline ${index}`,
      role: "Waits for a model run",
      description: "Synthetic scheduler fairness fixture.",
      model: { provider: "openai", id: "gpt-4.1" },
    });
    app.agents.complete(
      id,
      {
        username: "mate_" + id.replaceAll("-", "").slice(0, 27),
        uid: 24000 + index,
        gid: 24000 + index,
        home: `/var/lib/mate/agents/${id}`,
      },
      app.chat,
      true,
    );
    const direct = app.chat.getOrCreateAgentDirectChannel(id)!;
    app.chat.createMessage(direct.id, `离线 Agent ${index} 的排队输入。`);
  }

  const onlineAgentId = randomUUID();
  app.agents.prepare({
    id: onlineAgentId,
    nodeId: onlineNode.id,
    name: "Online partner",
    role: "Runs when ready",
    description: "Must not be starved by offline entries.",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  app.agents.complete(
    onlineAgentId,
    {
      username: "mate_" + onlineAgentId.replaceAll("-", "").slice(0, 27),
      uid: 25001,
      gid: 25001,
      home: `/var/lib/mate/agents/${onlineAgentId}`,
    },
    app.chat,
    true,
  );
  const onlineDirect = app.chat.getOrCreateAgentDirectChannel(onlineAgentId)!;
  app.chat.createMessage(onlineDirect.id, "在线 Agent 的排队输入。");

  const credential = await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-scheduler-key" }),
  });
  expect(credential.status).toBe(204);
  const deadline = Date.now() + 3000;
  let run: Record<string, unknown> | undefined;
  while (Date.now() < deadline && !run) {
    run = onlineNode.socket.sent
      .map((text) => JSON.parse(text) as Record<string, unknown>)
      .find((message) => message.type === "control.agent.run" && message.agentId === onlineAgentId);
    if (!run) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(run).toMatchObject({
    type: "control.agent.run",
    agentId: onlineAgentId,
    channelId: onlineDirect.id,
  });
  expect(app.chat.listPendingDeliveries("agent", onlineAgentId).deliveries).toHaveLength(1);
});

it("retains one failed request and retries it with the same Agent and provisioning IDs", async () => {
  const app = setup();
  const cookie = await login(app);
  const { id: nodeId, socket } = await pairNode(app, cookie);
  const input = {
    id: "a82eb7db-26f7-40f8-9bb8-8baf21dc5c0a",
    name: "Writing partner",
    role: "Writes and edits",
    description: "A writing colleague.",
    nodeId,
    model: { provider: "openai", id: "gpt-4.1" },
  };
  const failedCreation = app.request("/api/owner/agents", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const firstCommand = JSON.parse(socket.sent.at(-1)!) as { requestId: string };
  const concurrentDuplicate = app.request("/api/owner/agents", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.provision.result",
      requestId: firstCommand.requestId,
      agentId: input.id,
      ok: false,
      code: "permission_denied",
      message: "节点服务需要 root 权限才能建立 Agent Linux 账号。",
    }),
  );
  const [failed, concurrentFailed] = await Promise.all([failedCreation, concurrentDuplicate]);
  expect(failed.status).toBe(502);
  expect(concurrentFailed.status).toBe(502);
  const failedAgent = (await failed.json()) as { agent: { sessionId: string; status: string } };
  const concurrentFailedAgent = (await concurrentFailed.json()) as {
    agent: { sessionId: string; status: string };
  };
  expect(failedAgent.agent.status).toBe("failed");
  expect(concurrentFailedAgent.agent).toEqual(failedAgent.agent);

  const retry = app.request("/api/owner/agents", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const secondCommand = JSON.parse(socket.sent.at(-1)!) as {
    type: string;
    requestId: string;
    agentId: string;
  };
  expect(secondCommand).toEqual({
    ...firstCommand,
    type: "control.agent.provision",
    agentId: input.id,
  });
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.provision.result",
      requestId: secondCommand.requestId,
      agentId: input.id,
      ok: true,
      identity: {
        username: "mate_a82eb7db26f740f89bb88baf21d",
        uid: 23002,
        gid: 23002,
        home: `/var/lib/mate/agents/${input.id}`,
      },
    }),
  );
  const succeeded = await retry;
  expect(succeeded.status).toBe(200);
  const agent = (await succeeded.json()) as {
    agent: { id: string; sessionId: string; status: string };
  };
  expect(agent.agent).toMatchObject({
    id: input.id,
    sessionId: failedAgent.agent.sessionId,
    status: "waiting_credentials",
  });
});
