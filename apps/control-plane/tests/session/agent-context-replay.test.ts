import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import {
  eventually,
  login,
  ownerPassword,
  startControlPlane,
  startNode,
  stopProcess,
  type ProcessOutput,
} from "../support/environment/run-services.js";

it("keeps the actual OpenAI request prefix across tools, DM, public/private channels, threads and restarts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mate-full-session-"));
  chmodSync(directory, 0o700);
  writeFileSync(join(directory, "owner-password"), ownerPassword, { mode: 0o600 });
  const requests: any[] = [];
  let control: ProcessOutput | undefined;
  let node: ProcessOutput | undefined;
  let turn = 0;
  let updateConfiguration: (() => Promise<void>) | undefined;
  let configurationTurn = -1;
  const provider = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    const step = turn++;
    if (step === configurationTurn) await updateConfiguration?.();
    const calls =
      step === 0 || step === configurationTurn
        ? [
            { id: "discover", name: "tools.list", arguments: {} },
            { id: "describe", name: "tools.describe", arguments: { name: "process.exec" } },
          ]
        : step === 1
          ? [
              {
                id: "execute-once",
                name: "tools.call",
                arguments: {
                  name: "process.exec",
                  input: { command: "printf 'once\\n' >> ledger.txt" },
                },
              },
            ]
          : step === 2
            ? [{ id: "invalid", name: "tools.describe", arguments: {} }]
            : [];
    response.writeHead(200, { "content-type": "text/event-stream" });
    const output = [
      ...(step === 0
        ? [
            {
              type: "reasoning",
              id: "rs_signed",
              summary: [{ type: "summary_text", text: "Synthetic reasoning" }],
              encrypted_content: "synthetic-replay-signature",
            },
          ]
        : []),
      ...(calls.length
        ? calls.map((call) => ({
            type: "function_call",
            id: `fc_${call.id}`,
            call_id: call.id,
            name: call.name,
            arguments: JSON.stringify(call.arguments),
            status: "completed",
          }))
        : [
            {
              type: "message",
              id: `msg_${step}`,
              role: "assistant",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: step === 3 ? "x".repeat(1_100_000) : `  final ${step}\n`,
                  annotations: [],
                },
              ],
            },
          ]),
    ];
    output.forEach((item, index) =>
      response.write(
        `data: ${JSON.stringify({ type: "response.output_item.done", output_index: index, item })}\n\n`,
      ),
    );
    response.end(
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: `response-${step}`,
          status: "completed",
          output,
          usage: {
            input_tokens: 100,
            output_tokens: 10,
            total_tokens: 110,
            input_tokens_details: { cached_tokens: 60 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      })}\n\n`,
    );
  });
  await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
  const providerAddress = provider.address();
  if (!providerAddress || typeof providerAddress === "string") throw new Error("No provider port");
  let db: Database.Database | undefined;
  try {
    control = startControlPlane(directory);
    let origin = `http://127.0.0.1:${(await control.waitFor(/MATE_CONTROL_PLANE_LISTENING (\d+)/))[1]}`;
    let cookie = await login(origin);
    const api = async (path: string, body?: unknown, method = "POST") => {
      const response = await fetch(origin + path, {
        method,
        headers: { cookie, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(response.ok, await response.clone().text()).toBe(true);
      return response.status === 204 ? undefined : response.json();
    };
    const pairing = await api("/api/owner/nodes/pairing-tokens");
    const nodeOptions = {
      nodeData: join(directory, "node-data"),
      workspaceRoot: join(directory, "workspaces"),
    };
    node = startNode({ ...nodeOptions, origin, pairingToken: pairing.pairingToken });
    const nodeId = (await node.waitFor(/MATE_NODE_PAIRED ([0-9a-f-]+)/i))[1]!;
    const agentId = randomUUID();
    const created = await api("/api/owner/agents", {
      id: agentId,
      nodeId,
      name: "Replay",
      role: "Synthetic",
      description: "Synthetic",
      model: { provider: "openai", id: "gpt-4o-mini" },
    });
    const dm = (await api(`/api/owner/agents/${agentId}/direct-channel`)).channel.id;
    await api(
      "/api/owner/model-credentials/openai",
      { apiKey: `http://127.0.0.1:${providerAddress.port}/v1` },
      "PUT",
    );
    db = new Database(join(directory, "control-plane-data", "control-plane.sqlite"), {
      readonly: true,
    });
    const complete = async (count: number) =>
      eventually(() => {
        const row = db!
          .prepare<[string], { n: number }>(
            "SELECT COUNT(*) AS n FROM owner_agent_runs WHERE agent_id=? AND state='completed'",
          )
          .get(agentId)!;
        return row.n === count ? true : undefined;
      }, `completed run ${count}`);
    await api(`/api/owner/channels/${dm}/messages`, { text: "私信工作" });
    await complete(1);
    expect(requests).toHaveLength(4);
    expect(requests[3].input.at(-1)).toMatchObject({
      type: "function_call_output",
      call_id: "invalid",
    });
    expect(requests[3].input.at(-1).output).toContain("required");
    expect(readFileSync(join(created.agent.linuxIdentity.workspace, "ledger.txt"), "utf8")).toBe(
      "once\n",
    );
    const channel = await api("/api/owner/channels", {
      name: "Public",
      description: "Synthetic",
      visibility: "public",
    });
    await api(`/api/owner/channels/${channel.id}/invitations`, { agentId });
    const root = await api(`/api/owner/channels/${channel.id}/messages`, { text: "公开频道工作" });
    await complete(2);
    await stopProcess(node);
    node = undefined;
    await stopProcess(control);
    control = undefined;
    control = startControlPlane(directory);
    origin = `http://127.0.0.1:${(await control.waitFor(/MATE_CONTROL_PLANE_LISTENING (\d+)/))[1]}`;
    cookie = await login(origin);
    node = startNode({ ...nodeOptions, origin });
    await node.waitFor(/MATE_NODE_CONNECTED/);
    await api(`/api/owner/channels/${channel.id}/messages`, {
      text: "讨论串工作",
      rootId: root.id,
    });
    await complete(3);
    await api(`/api/owner/channels/${dm}/messages`, { text: "回到私信" });
    await complete(4);
    expect(requests).toHaveLength(7);
    const privateChannel = await api("/api/owner/channels", {
      name: "Private",
      description: "Synthetic",
      visibility: "private",
    });
    await api(`/api/owner/channels/${privateChannel.id}/invitations`, { agentId });
    await api(`/api/owner/channels/${privateChannel.id}/messages`, { text: "私有频道工作" });
    await complete(5);
    expect(requests).toHaveLength(8);
    for (let index = 1; index < requests.length; index++) {
      expect(requests[index].input.slice(0, requests[index - 1].input.length)).toEqual(
        requests[index - 1].input,
      );
      expect(requests[index].tools).toEqual(requests[0].tools);
    }
    expect(JSON.stringify(requests[5].input.at(-1).content)).toContain(root.id);
    expect(requests[4].input.at(-2).content[0].text).toBe("x".repeat(1_100_000));
    expect(readFileSync(join(created.agent.linuxIdentity.workspace, "ledger.txt"), "utf8")).toBe(
      "once\n",
    );
    expect(requests[1].input).toContainEqual({
      type: "reasoning",
      id: "rs_signed",
      summary: [{ type: "summary_text", text: "Synthetic reasoning" }],
      encrypted_content: "synthetic-replay-signature",
    });
    const savedHistory = db
      .prepare("SELECT payload_json FROM owner_agent_session_records WHERE agent_id=? ORDER BY seq")
      .all(agentId);
    configurationTurn = requests.length;
    updateConfiguration = async () => {
      await api(`/api/owner/agents/${agentId}/profile`, { role: "Changed next run" }, "PATCH");
      await api(
        `/api/owner/agents/${agentId}/model`,
        { provider: "openai", id: "gpt-4.1-mini" },
        "PUT",
      );
    };
    await api(`/api/owner/channels/${dm}/messages`, { text: "运行中修改配置" });
    await complete(6);
    expect(requests).toHaveLength(10);
    expect(requests[8].model).toBe("gpt-4o-mini");
    expect(requests[9].model).toBe("gpt-4o-mini");
    expect(requests[9].input[0]).toEqual(requests[0].input[0]);
    await api(`/api/owner/channels/${dm}/messages`, { text: "采用新配置" });
    await complete(7);
    expect(requests[10].model).toBe("gpt-4.1-mini");
    expect(JSON.stringify(requests[10].input[0])).toContain("Changed next run");
    expect(
      db
        .prepare(
          "SELECT payload_json FROM owner_agent_session_records WHERE agent_id=? ORDER BY seq LIMIT ?",
        )
        .all(agentId, savedHistory.length),
    ).toEqual(savedHistory);
    const configurations = db
      .prepare<[string], { payload_json: string }>(
        "SELECT payload_json FROM owner_agent_session_records WHERE agent_id=? AND kind='configuration' ORDER BY seq",
      )
      .all(agentId);
    expect(JSON.parse(configurations.at(-1)!.payload_json).configuration).toMatchObject({
      modelId: "gpt-4.1-mini",
      piAgentVersion: "1.0.0",
      piAiVersion: "1.0.0",
    });
  } finally {
    db?.close();
    await stopProcess(node);
    await stopProcess(control);
    await new Promise<void>((done) => provider.close(() => done()));
    rmSync(directory, { recursive: true, force: true });
  }
}, 40_000);
