import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import {
  createCoordinatedCheckpoint,
  restoreCoordinatedCheckpoint,
  verifyCoordinatedCheckpoint,
} from "../../src/deployment/coordinated-checkpoint.js";
import {
  eventually,
  login,
  ownerPassword,
  startControlPlane,
  startNode,
  stopProcess,
  type ProcessOutput,
} from "../helpers/run-services.js";

async function exerciseCompaction(
  summaryMode:
    | "success"
    | "repeat"
    | "toolCall"
    | "length"
    | "network"
    | "uncuttable"
    | "overflow"
    | "interrupt"
    | "recoveryOrder",
) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "mate-compaction-")));
  chmodSync(directory, 0o700);
  writeFileSync(join(directory, "owner-password"), ownerPassword, { mode: 0o600 });
  const requests: any[] = [];
  let normal = 0;
  const provider = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    const isSummary = JSON.stringify(body.input?.[0]).includes("context summarization assistant");
    if (isSummary && summaryMode === "network") {
      response.destroy();
      return;
    }
    const turn = isSummary ? -1 : normal++;
    if (summaryMode === "overflow" && turn === 1) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: { code: "context_length_exceeded", message: "maximum context length exceeded" },
        }),
      );
      return;
    }
    const output =
      isSummary && summaryMode === "toolCall"
        ? [
            {
              type: "function_call",
              id: `unexpected-${requests.length}`,
              call_id: `unexpected-${requests.length}`,
              name: "tools.list",
              arguments: "{}",
              status: "completed",
            },
          ]
        : isSummary
          ? [
              {
                type: "message",
                id: "summary",
                role: "assistant",
                status: "completed",
                content: [
                  {
                    type: "output_text",
                    text: "## Goal\nPreserve the prior request and continue after the tool result.",
                    annotations: [],
                  },
                ],
              },
            ]
          : turn === 0 || (summaryMode === "repeat" && turn === 1)
            ? [
                {
                  type: "message",
                  id: `long-work-${turn}`,
                  role: "assistant",
                  status: "completed",
                  content: [
                    {
                      type: "output_text",
                      text:
                        summaryMode === "uncuttable" || summaryMode === "recoveryOrder"
                          ? "short"
                          : "x".repeat(100_000),
                      annotations: [],
                    },
                  ],
                },
                ...(summaryMode === "overflow"
                  ? []
                  : [
                      {
                        type: "function_call",
                        id: `list-${turn}`,
                        call_id: `list-${turn}`,
                        name: "tools.list",
                        arguments: "{}",
                        status: "completed",
                      },
                    ]),
              ]
            : [
                {
                  type: "message",
                  id: `done-${turn}`,
                  role: "assistant",
                  status: "completed",
                  content: [{ type: "output_text", text: `done ${turn}`, annotations: [] }],
                },
              ];
    response.writeHead(200, { "content-type": "text/event-stream" });
    output.forEach((item, index) =>
      response.write(
        `data: ${JSON.stringify({ type: "response.output_item.done", output_index: index, item })}\n\n`,
      ),
    );
    response.end(
      `data: ${JSON.stringify({ type: "response.completed", response: { id: `response-${requests.length}`, status: isSummary && summaryMode === "length" ? "incomplete" : "completed", ...(isSummary && summaryMode === "length" ? { incomplete_details: { reason: "max_output_tokens" } } : {}), output, usage: { input_tokens: (turn === 0 && summaryMode !== "overflow" && summaryMode !== "recoveryOrder") || (summaryMode === "repeat" && turn === 1) ? 115_000 : 100, output_tokens: 10, total_tokens: (turn === 0 && summaryMode !== "overflow" && summaryMode !== "recoveryOrder") || (summaryMode === "repeat" && turn === 1) ? 115_010 : 110, ...(isSummary && summaryMode === "length" ? {} : { input_tokens_details: { cached_tokens: 0 } }) } } })}\n\n`,
    );
  });
  await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("No provider port");
  let control: ProcessOutput | undefined,
    node: ProcessOutput | undefined,
    db: Database.Database | undefined;
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
      modelWorkerEntry: resolve(
        summaryMode === "interrupt"
          ? "tests/fixtures/interrupted-compaction-model-worker.mjs"
          : summaryMode === "recoveryOrder"
            ? "tests/fixtures/interrupted-tool-result-model-worker.mjs"
            : "tests/fixtures/protocol-model-worker.mjs",
      ),
    };
    node = startNode({ ...nodeOptions, origin, pairingToken: pairing.pairingToken });
    const nodeId = (await node.waitFor(/MATE_NODE_PAIRED ([0-9a-f-]+)/i))[1]!;
    const agentId = randomUUID();
    await api("/api/owner/agents", {
      id: agentId,
      nodeId,
      name: "Compact",
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
    await api(`/api/owner/channels/${dm}/messages`, {
      text: "Continue the assigned task after listing tools",
    });
    if (summaryMode === "interrupt") {
      await eventually(() => {
        const failed = db!
          .prepare("SELECT COUNT(*) AS n FROM owner_agent_runs WHERE agent_id=? AND state='failed'")
          .get(agentId) as { n: number };
        return failed.n === 1 ? true : undefined;
      }, "interrupted checkpoint submission");
      await stopProcess(node);
      node = undefined;
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM owner_agent_session_records WHERE agent_id=? AND kind='compaction'",
          )
          .get(agentId),
      ).toEqual({ n: 0 });
      node = startNode({
        ...nodeOptions,
        modelWorkerEntry: resolve("tests/fixtures/protocol-model-worker.mjs"),
        origin,
      });
      await node.waitFor(/MATE_NODE_CONNECTED/);
      await completed(1);
      expect(
        requests.filter((request) =>
          JSON.stringify(request.input?.[0]).includes("context summarization assistant"),
        ),
      ).toHaveLength(2);
      expect(
        requests.filter(
          (request) =>
            !JSON.stringify(request.input?.[0]).includes("context summarization assistant"),
        ),
      ).toHaveLength(2);
      expect(JSON.stringify(requests.at(-1).input)).toContain("[会话压缩摘要]");
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM owner_agent_session_records WHERE agent_id=? AND kind='compaction'",
          )
          .get(agentId),
      ).toEqual({ n: 1 });
      return;
    }
    if (summaryMode === "recoveryOrder") {
      await eventually(() => {
        const failed = db!
          .prepare("SELECT COUNT(*) AS n FROM owner_agent_runs WHERE agent_id=? AND state='failed'")
          .get(agentId) as { n: number };
        return failed.n === 1 ? true : undefined;
      }, "missing tool result after worker exit");
      await stopProcess(node);
      node = undefined;
      await api(`/api/owner/channels/${dm}/messages`, { text: "New input after the tool call" });
      node = startNode({
        ...nodeOptions,
        modelWorkerEntry: resolve("tests/fixtures/protocol-model-worker.mjs"),
        origin,
      });
      await node.waitFor(/MATE_NODE_CONNECTED/);
      await completed(1);
      expect(requests).toHaveLength(2);
      const input = requests[1].input;
      const result = input.findIndex((part: any) => part.type === "function_call_output");
      const newInput = input.findIndex((part: any) =>
        JSON.stringify(part).includes("New input after the tool call"),
      );
      expect(result).toBeGreaterThan(-1);
      expect(newInput).toBeGreaterThan(result);
      return;
    }
    if (summaryMode === "overflow") {
      await completed(1);
      await api(`/api/owner/channels/${dm}/messages`, {
        text: "Trigger the provider context overflow",
      });
      await completed(2);
      expect(requests).toHaveLength(4);
      expect(JSON.stringify(requests[2].input[0])).toContain("context summarization assistant");
      expect(JSON.stringify(requests[3].input)).toContain("[会话压缩摘要]");
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM owner_agent_session_records WHERE agent_id=? AND kind='compaction'",
          )
          .get(agentId),
      ).toEqual({ n: 1 });
      return;
    }
    if (
      summaryMode === "toolCall" ||
      summaryMode === "length" ||
      summaryMode === "uncuttable" ||
      summaryMode === "network"
    ) {
      await eventually(() => {
        const control = db!
          .prepare(
            "SELECT paused_reason,temporary_failures FROM owner_agent_run_control WHERE agent_id=?",
          )
          .get(agentId) as { paused_reason: string | null; temporary_failures: number };
        return control?.paused_reason === "context" ? control : undefined;
      }, "bounded compaction failure");
      expect(requests).toHaveLength(summaryMode === "uncuttable" ? 1 : 3);
      expect(requests.slice(1).every((request) => request.tools === undefined)).toBe(true);
      const rows = db
        .prepare("SELECT kind,payload_json FROM owner_agent_session_records WHERE agent_id=?")
        .all(agentId) as Array<{ kind: string; payload_json: string }>;
      expect(rows.filter((row) => row.kind === "compaction")).toHaveLength(0);
      expect(rows.filter((row) => row.kind === "summary_usage")).toHaveLength(
        summaryMode === "uncuttable" || summaryMode === "network" ? 0 : 2,
      );
      if (summaryMode !== "uncuttable" && summaryMode !== "network") {
        const usage = await api(`/api/owner/agents/${agentId}/usage`, undefined, "GET");
        expect(usage.summary.requestCount).toBe(2);
        expect(usage.summary.tokens.allInput.value).toBe(200);
        expect(usage.total.requestCount).toBe(3);
        expect(usage.latestNormal.tokens.allInput.value).toBe(115_000);
      }
      if (summaryMode === "length") {
        const usage = JSON.parse(rows.find((row) => row.kind === "summary_usage")!.payload_json);
        expect(usage.usage.cacheRead).toBe(0);
        expect(usage.reportedUsage).toEqual({
          sourceApi: "openai-responses",
          inputBasis: "includes_cache",
          input: 100,
          output: 10,
        });
      }
      expect(
        rows.some(
          (row) =>
            row.kind === "message" &&
            row.payload_json.includes("Continue the assigned task after listing tools"),
        ),
      ).toBe(true);
      const activity = db
        .prepare(
          "SELECT detail_json FROM owner_agent_activity WHERE agent_id=? AND kind='run.failed' ORDER BY seq DESC LIMIT 1",
        )
        .get(agentId) as { detail_json: string };
      const detail = JSON.parse(activity.detail_json);
      expect(detail.code).toBe("context_failed");
      expect(detail.reason).toMatch(
        summaryMode === "uncuttable"
          ? /No legal compaction range/
          : summaryMode === "network"
            ? /failed|fetch|network/i
            : /Summarization failed/,
      );
      return;
    }
    await completed(1);
    expect(requests).toHaveLength(summaryMode === "repeat" ? 5 : 3);
    expect(JSON.stringify(requests[0].input)).toContain(
      "Continue the assigned task after listing tools",
    );
    expect(JSON.stringify(requests[1].input[0])).toContain("context summarization assistant");
    expect(requests[1].tools).toBeUndefined();
    expect(JSON.stringify(requests[1].input)).toContain("PREFIX of a turn");
    expect(JSON.stringify(requests[2].input)).toContain("[会话压缩摘要]");
    expect(JSON.stringify(requests[2].input)).toContain("function_call_output");
    if (summaryMode === "repeat") {
      expect(JSON.stringify(requests[3].input)).toContain("<previous-summary>");
      expect(JSON.stringify(requests[4].input)).toContain("[会话压缩摘要]");
    }
    const rows = db
      .prepare(
        "SELECT kind,payload_json FROM owner_agent_session_records WHERE agent_id=? ORDER BY seq",
      )
      .all(agentId) as Array<{ kind: string; payload_json: string }>;
    expect(rows.filter((row) => row.kind === "compaction")).toHaveLength(
      summaryMode === "repeat" ? 2 : 1,
    );
    expect(rows.filter((row) => row.kind === "summary_usage")).toHaveLength(
      summaryMode === "repeat" ? 2 : 1,
    );
    const usageRows = rows
      .filter((row) => row.kind === "summary_usage")
      .map((row) => JSON.parse(row.payload_json));
    expect(usageRows[0].reportedUsage).toEqual({
      sourceApi: "openai-responses",
      inputBasis: "includes_cache",
      input: 100,
      output: 10,
      cacheRead: 0,
    });
    expect(usageRows[0].reportedUsage).not.toHaveProperty("cacheWrite");
    const usageBeforeRestart = await api(`/api/owner/agents/${agentId}/usage`, undefined, "GET");
    expect(usageBeforeRestart.summary.requestCount).toBe(summaryMode === "repeat" ? 2 : 1);
    expect(usageBeforeRestart.normal.requestCount).toBe(summaryMode === "repeat" ? 3 : 2);
    expect(usageBeforeRestart.total.requestCount).toBe(requests.length);
    expect(usageBeforeRestart.summary.tokens.allInput.value).toBe(
      summaryMode === "repeat" ? 200 : 100,
    );
    expect(usageBeforeRestart.summary.cacheHitRate.value).toBe(0);
    expect(usageBeforeRestart.latestNormal.tokens.allInput.value).toBe(100);
    const checkpoints = rows
      .filter((row) => row.kind === "compaction")
      .map((row) => JSON.parse(row.payload_json));
    expect(checkpoints[0].summaryRequestIds).toEqual([usageRows[0].id]);
    expect(rows.find((row) => row.kind === "compaction")?.payload_json).toContain(
      "Preserve the prior request",
    );
    await stopProcess(node);
    node = undefined;
    await stopProcess(control);
    control = undefined;
    if (summaryMode === "success") {
      db.close();
      db = undefined;
      const state = {
        controlPlaneDataDir: join(directory, "control-plane-data"),
        nodeDataDir: nodeOptions.nodeData,
        agentHomeRoot: nodeOptions.workspaceRoot,
      };
      const backup = join(directory, "coordinated-backup");
      await createCoordinatedCheckpoint(state, backup, async () => {});
      expect(verifyCoordinatedCheckpoint(backup).entries.length).toBeGreaterThan(0);
      await restoreCoordinatedCheckpoint(
        backup,
        state,
        async () => {},
        async () => {},
      );
      db = new Database(join(state.controlPlaneDataDir, "control-plane.sqlite"), {
        readonly: true,
      });
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM owner_agent_session_records WHERE agent_id=? AND kind='compaction'",
          )
          .get(agentId),
      ).toEqual({ n: 1 });
    }
    control = startControlPlane(directory);
    origin = `http://127.0.0.1:${(await control.waitFor(/MATE_CONTROL_PLANE_LISTENING (\d+)/))[1]}`;
    cookie = await login(origin);
    expect((await api(`/api/owner/agents/${agentId}/usage`, undefined, "GET")).total).toEqual(
      usageBeforeRestart.total,
    );
    node = startNode({ ...nodeOptions, origin });
    await node.waitFor(/MATE_NODE_CONNECTED/);
    await api(`/api/owner/channels/${dm}/messages`, { text: "Follow-up after restart" });
    await completed(2);
    const usageAfterRestart = await api(`/api/owner/agents/${agentId}/usage`, undefined, "GET");
    expect(usageAfterRestart.total.requestCount).toBe(usageBeforeRestart.total.requestCount + 1);
    expect(JSON.stringify(requests.at(-1).input)).toContain("[会话压缩摘要]");
    expect(JSON.stringify(requests.at(-1).input)).not.toContain(
      "Continue the assigned task after listing tools",
    );
    expect(
      rows
        .filter((row) => row.kind === "message")
        .some((row) => row.payload_json.includes("Continue the assigned task after listing tools")),
    ).toBe(true);
  } finally {
    db?.close();
    await stopProcess(node);
    await stopProcess(control);
    await new Promise<void>((done) => provider.close(() => done()));
    rmSync(directory, { recursive: true, force: true });
  }
}

it(
  "compacts a long tool loop through the control plane and resumes from its confirmed checkpoint",
  () => exerciseCompaction("success"),
  30_000,
);
it(
  "rejects summary tool calls without executing them or retrying forever",
  () => exerciseCompaction("toolCall"),
  30_000,
);
it(
  "folds a prior checkpoint into a second compaction during the same tool loop",
  () => exerciseCompaction("repeat"),
  30_000,
);
it(
  "rejects a truncated summary without installing a checkpoint",
  () => exerciseCompaction("length"),
  30_000,
);
it(
  "does not count an unconfirmed summary transport failure",
  () => exerciseCompaction("network"),
  30_000,
);
it(
  "reports an uncuttable context without discarding its original messages",
  () => exerciseCompaction("uncuttable"),
  30_000,
);
it(
  "recovers once from a provider context overflow using a confirmed checkpoint",
  () => exerciseCompaction("overflow"),
  30_000,
);
it(
  "keeps original context when the model process exits before checkpoint submission, then retries",
  () => exerciseCompaction("interrupt"),
  30_000,
);
it(
  "replays a missing tool result before pending new input after a model-process restart",
  () => exerciseCompaction("recoveryOrder"),
  30_000,
);
