import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
} from "../helpers/run-services.js";

it("reports weighted Agent usage through owner HTTP across model and service restarts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mate-agent-usage-"));
  chmodSync(directory, 0o700);
  writeFileSync(join(directory, "owner-password"), ownerPassword, { mode: 0o600 });
  const usages = [
    { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 50 } },
    { input_tokens: 900, output_tokens: 30, input_tokens_details: { cached_tokens: 90 } },
    { input_tokens: 200, output_tokens: 5 },
    { input_tokens: 50, output_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
    { input_tokens: 0, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } },
    { input_tokens: 70, output_tokens: 3, input_tokens_details: { cached_tokens: 7 } },
  ];
  let requests = 0;
  const provider = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* drain request */
    }
    const usage = usages[requests++] ?? usages.at(-1)!;
    if (requests >= 7) {
      response.destroy();
      return;
    }
    if (requests === 6) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({
          type: "response.failed",
          response: {
            id: "failed-response",
            status: "failed",
            error: { code: "server_error", message: "synthetic failure" },
            output: [],
            usage,
          },
        })}\n\n`,
      );
      return;
    }
    const output = [
      {
        type: "message",
        id: `output-${requests}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "done", annotations: [] }],
      },
    ];
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: output[0] })}\n\n`,
    );
    response.end(
      `data: ${JSON.stringify({ type: "response.completed", response: { id: `response-${requests}`, status: "completed", output, usage } })}\n\n`,
    );
  });
  await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("No provider port");
  let control: ProcessOutput | undefined, node: ProcessOutput | undefined;
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
      modelWorkerEntry: resolve("tests/fixtures/protocol-model-worker.mjs"),
    };
    node = startNode({ ...nodeOptions, origin, pairingToken: pairing.pairingToken });
    const nodeId = (await node.waitFor(/MATE_NODE_PAIRED ([0-9a-f-]+)/i))[1]!;
    const agentId = randomUUID();
    await api("/api/owner/agents", {
      id: agentId,
      nodeId,
      name: "Usage",
      role: "Synthetic",
      description: "Synthetic",
      model: { provider: "openai", id: "gpt-4o-mini" },
    });
    const otherId = randomUUID();
    await api("/api/owner/agents", {
      id: otherId,
      nodeId,
      name: "Other",
      role: "Synthetic",
      description: "Synthetic",
      model: { provider: "openai", id: "gpt-4o-mini" },
    });
    const dm = (await api(`/api/owner/agents/${agentId}/direct-channel`)).channel.id;
    await api(
      "/api/owner/model-credentials/openai",
      { apiKey: `http://127.0.0.1:${address.port}/v1` },
      "PUT",
    );
    const usagePath = `/api/owner/agents/${agentId}/usage`;
    expect((await fetch(origin + usagePath)).status).toBe(401);
    expect(
      (await fetch(origin + `/api/owner/agents/${randomUUID()}/usage`, { headers: { cookie } }))
        .status,
    ).toBe(404);
    expect(
      (await api(`/api/owner/agents/${otherId}/usage`, undefined, "GET")).normal.requestCount,
    ).toBe(0);
    db = new Database(join(directory, "control-plane-data", "control-plane.sqlite"), {
      readonly: true,
    });
    const completed = async (count: number) =>
      eventually(() => {
        const row = db!
          .prepare(
            "SELECT COUNT(*) AS n FROM owner_agent_runs WHERE agent_id=? AND state='completed'",
          )
          .get(agentId) as { n: number };
        return row.n === count ? true : undefined;
      }, `completed run ${count}`);
    await api(`/api/owner/channels/${dm}/messages`, { text: "first" });
    await completed(1);
    await api(`/api/owner/channels/${dm}/messages`, { text: "second" });
    await completed(2);
    const two = await api(usagePath, undefined, "GET");
    expect(two.normal.requestCount).toBe(2);
    expect(two.normal.tokens.allInput.value).toBe(1000);
    expect(two.normal.tokens.cacheRead.value).toBe(140);
    expect(two.normal.tokens.output.value).toBe(50);
    expect(two.normal.cacheHitRate.value).toBe(0.14);
    expect(two.latestNormal.tokens.allInput.value).toBe(900);
    expect(two.latestNormal.cacheHitRate.value).toBe(0.1);
    expect(two.summary.requestCount).toBe(0);
    expect(two.total.tokens.allInput.value).toBe(1000);
    await stopProcess(node);
    node = undefined;
    await stopProcess(control);
    control = undefined;
    control = startControlPlane(directory);
    origin = `http://127.0.0.1:${(await control.waitFor(/MATE_CONTROL_PLANE_LISTENING (\d+)/))[1]}`;
    cookie = await login(origin);
    node = startNode({ ...nodeOptions, origin });
    await node.waitFor(/MATE_NODE_CONNECTED/);
    expect((await api(usagePath, undefined, "GET")).normal.tokens.allInput.value).toBe(1000);
    await api(`/api/owner/channels/${dm}/messages`, { text: "third" });
    await completed(3);
    const three = await api(usagePath, undefined, "GET");
    expect(three.normal.requestCount).toBe(3);
    expect(three.normal.tokens.allInput.value).toBe(1200);
    expect(three.normal.tokens.cacheRead).toEqual({
      value: 140,
      knownRequests: 2,
      missingRequests: 1,
    });
    expect(three.normal.cacheHitRate).toEqual({
      value: 0.14,
      knownRequests: 2,
      missingRequests: 1,
    });
    expect(three.latestNormal.tokens.allInput.value).toBe(200);
    expect(three.latestNormal.tokens.cacheRead.value).toBeNull();
    expect(three.latestNormal.cacheHitRate.value).toBeNull();
    await api(`/api/owner/channels/${dm}/messages`, { text: "confirmed zero cache hit" });
    await completed(4);
    const four = await api(usagePath, undefined, "GET");
    expect(four.latestNormal.cacheHitRate.value).toBe(0);
    expect(four.normal.cacheHitRate.value).toBe(140 / 1050);
    await api(`/api/owner/channels/${dm}/messages`, { text: "zero input denominator" });
    await completed(5);
    const five = await api(usagePath, undefined, "GET");
    expect(five.latestNormal.cacheHitRate).toEqual({
      value: null,
      knownRequests: 0,
      missingRequests: 1,
    });
    expect(five.normal.cacheHitRate).toEqual({
      value: 140 / 1050,
      knownRequests: 3,
      missingRequests: 2,
    });
    await api(`/api/owner/channels/${dm}/messages`, {
      text: "failed provider response with reported usage",
    });
    await eventually(() => {
      const row = db!
        .prepare(
          "SELECT COUNT(*) AS n FROM owner_agent_session_records WHERE agent_id=? AND payload_json LIKE '%\"modelRequest\":true%'",
        )
        .get(agentId) as { n: number };
      return row.n >= 6 ? true : undefined;
    }, "failed response usage commit");
    const failed = await api(usagePath, undefined, "GET");
    expect(failed.normal.requestCount).toBe(6);
    expect(failed.latestNormal.tokens.allInput.value).toBe(70);
    expect(failed.latestNormal.tokens.cacheRead.value).toBe(7);
    expect(failed.latestNormal.tokens.output.value).toBe(3);
    await api(`/api/owner/channels/${dm}/messages`, { text: "network failure before a response" });
    await eventually(() => {
      const row = db!
        .prepare(
          "SELECT COUNT(*) AS n FROM owner_agent_session_records WHERE agent_id=? AND kind='message' AND json_extract(payload_json,'$.message.stopReason')='error'",
        )
        .get(agentId) as { n: number };
      return requests >= 7 && row.n >= 2 ? true : undefined;
    }, "unconfirmed transport failure");
    const unconfirmed = await api(usagePath, undefined, "GET");
    expect(unconfirmed.normal.requestCount).toBe(6);
    expect(unconfirmed.latestNormal.id).toBe(failed.latestNormal.id);
  } finally {
    db?.close();
    await stopProcess(node);
    await stopProcess(control);
    provider.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("reports positive Google SDK usage and keeps Pi-normalized zeros unavailable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mate-google-usage-"));
  chmodSync(directory, 0o700);
  writeFileSync(join(directory, "owner-password"), ownerPassword, { mode: 0o600 });
  let control: ProcessOutput | undefined, node: ProcessOutput | undefined;
  let db: Database.Database | undefined;
  try {
    control = startControlPlane(directory);
    const origin = `http://127.0.0.1:${(await control.waitFor(/MATE_CONTROL_PLANE_LISTENING (\d+)/))[1]}`;
    const cookie = await login(origin);
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
    node = startNode({
      origin,
      pairingToken: pairing.pairingToken,
      nodeData: join(directory, "node-data"),
      workspaceRoot: join(directory, "workspaces"),
      modelWorkerEntry: resolve("tests/fixtures/google-usage-model-worker.mjs"),
    });
    const nodeId = (await node.waitFor(/MATE_NODE_PAIRED ([0-9a-f-]+)/i))[1]!;
    const agentId = randomUUID();
    await api("/api/owner/agents", {
      id: agentId,
      nodeId,
      name: "Google usage",
      role: "Synthetic",
      description: "Synthetic",
      model: { provider: "google", id: "gemini-2.5-flash" },
    });
    const dm = (await api(`/api/owner/agents/${agentId}/direct-channel`)).channel.id;
    await api("/api/owner/model-credentials/google", { apiKey: "synthetic-google-key" }, "PUT");
    db = new Database(join(directory, "control-plane-data", "control-plane.sqlite"), {
      readonly: true,
    });
    const completed = async (count: number) =>
      eventually(() => {
        const row = db!
          .prepare(
            "SELECT COUNT(*) AS n FROM owner_agent_runs WHERE agent_id=? AND state='completed'",
          )
          .get(agentId) as { n: number };
        return row.n === count ? true : undefined;
      }, `Google completed run ${count}`);
    await api(`/api/owner/channels/${dm}/messages`, { text: "first" });
    await completed(1);
    const first = await api(`/api/owner/agents/${agentId}/usage`, undefined, "GET");
    expect(first.normal.tokens.allInput.value).toBe(100);
    expect(first.normal.tokens.cacheRead.value).toBe(60);
    expect(first.normal.tokens.output.value).toBe(20);
    expect(first.normal.tokens.reasoningOutput.value).toBe(5);
    expect(first.normal.cacheHitRate.value).toBe(0.6);
    await api(`/api/owner/channels/${dm}/messages`, { text: "second" });
    await completed(2);
    const second = await api(`/api/owner/agents/${agentId}/usage`, undefined, "GET");
    expect(second.normal.requestCount).toBe(2);
    expect(second.normal.tokens.allInput).toEqual({
      value: 100,
      knownRequests: 1,
      missingRequests: 1,
    });
    expect(second.latestNormal.tokens.allInput.value).toBeNull();
    expect(second.latestNormal.tokens.cacheRead.value).toBeNull();
  } finally {
    db?.close();
    await stopProcess(node);
    await stopProcess(control);
    rmSync(directory, { recursive: true, force: true });
  }
});
