import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "vitest";
import { ProcessOutput, eventually, login, ownerPassword, stopProcess } from "./run-services.js";

export interface ProviderRequest {
  input: Array<any>;
  messages?: Array<any>;
  tools?: Array<any>;
  model: string;
  [key: string]: unknown;
}

export function respond(
  response: ServerResponse,
  content: string | Array<{ name: string; input: unknown }>,
  prefix?: string,
  inputTokens = 50,
  identity?: string,
  observeWrite?: (accepted: boolean) => void,
): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const output =
    typeof content === "string"
      ? [
          {
            type: "message",
            id: `msg_${identity ?? "synthetic"}`,
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: content, annotations: [] }],
          },
        ]
      : [
          ...(prefix
            ? [
                {
                  type: "message",
                  id: `msg_${identity ?? "synthetic"}`,
                  role: "assistant",
                  status: "completed",
                  content: [{ type: "output_text", text: prefix, annotations: [] }],
                },
              ]
            : []),
          ...content.map((call, index) => ({
            type: "function_call",
            id: identity ? `fc_${identity}_${index}` : `fc_${index}`,
            call_id: identity ? `call_${identity}_${index}` : `call_${index}`,
            name: call.name,
            arguments: JSON.stringify(call.input),
            status: "completed",
          })),
        ];
  output.forEach((item, index) => {
    const accepted = response.write(
      `data: ${JSON.stringify({ type: "response.output_item.done", output_index: index, item })}\n\n`,
    );
    observeWrite?.(accepted);
  });
  response.end(
    `data: ${JSON.stringify({ type: "response.completed", response: { id: `resp_${identity ?? "synthetic"}`, status: "completed", output, usage: { input_tokens: inputTokens, output_tokens: 10, total_tokens: inputTokens + 10, input_tokens_details: { cached_tokens: 5 }, output_tokens_details: { reasoning_tokens: 0 } } } })}\n\n`,
  );
}

/** Real services and local provider HTTP/SSE; the only scripted boundary is model output. */
export async function loopFixture(
  handler: (request: ProviderRequest, response: ServerResponse) => void,
  extraControl: string | ((directory: string) => string) = "",
  contextWindow?: number,
  controlOptions = "",
) {
  const directory = mkdtempSync(join(tmpdir(), "mate-control-loop-"));
  chmodSync(directory, 0o700);
  writeFileSync(join(directory, "owner-password"), `${ownerPassword}\n`, { mode: 0o600 });
  const requests: ProviderRequest[] = [],
    pending = new Set<ServerResponse>();
  const provider = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(payload);
    pending.add(response);
    response.once("close", () => pending.delete(response));
    handler(payload, response);
  });
  await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
  const providerPort = (provider.address() as { port: number }).port;
  let control: ProcessOutput | undefined, node: ProcessOutput | undefined;
  let origin = "",
    cookie = "",
    nodeId = "";
  const additionalNodes: ProcessOutput[] = [];
  const modelForRun = `model => ({ ...model, baseUrl: "http://127.0.0.1:${providerPort}/v1"${contextWindow ? `, contextWindow: ${contextWindow}, maxTokens: 1000` : ""} })`;
  function startControl(port = 0, injectFault = true) {
    const hooks = injectFault
      ? typeof extraControl === "string"
        ? extraControl
        : extraControl(directory)
      : "";
    const runner = `const { startControlPlane } = await import(${JSON.stringify(pathToFileURL(resolve("dist/main.js")).href)}); startControlPlane(${port}, undefined, { dataDir: process.env.MATE_CONTROL_PLANE_DATA_DIR, passwordFile: process.env.MATE_OWNER_PASSWORD_FILE${controlOptions} }, { modelForRun: ${modelForRun}${hooks} });`;
    control = new ProcessOutput(
      spawn(process.execPath, ["--input-type=module", "--eval", runner], {
        env: {
          PATH: process.env.PATH,
          MATE_CONTROL_PLANE_DATA_DIR: join(directory, "control-plane-data"),
          MATE_OWNER_PASSWORD_FILE: join(directory, "owner-password"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    return control;
  }
  function launchNode(dataName: string, workspaceName: string, pairingToken?: string) {
    const data = join(directory, dataName),
      workspace = join(directory, workspaceName);
    const runner = `const { runLinuxNodeWithTestDependencies } = await import(${JSON.stringify(import.meta.resolve("@mate/node"))}); const { LinuxWorkspaceExecutor } = await import(${JSON.stringify(import.meta.resolve("@mate/node/workspace-execution"))}); const controller = new AbortController(); process.on("SIGTERM", () => controller.abort()); await runLinuxNodeWithTestDependencies({ controlPlaneUrl: ${JSON.stringify(origin)}, dataDirectory: ${JSON.stringify(data)}, agentWorkspaceRoot: ${JSON.stringify(workspace)}, pairingToken: ${JSON.stringify(pairingToken)}, heartbeatIntervalMs: 100, heartbeatTimeoutMs: 2000 }, controller.signal, { workspaceExecutor: new LinuxWorkspaceExecutor(${JSON.stringify(workspace)}, ${JSON.stringify(data)}) });`;
    return new ProcessOutput(
      spawn(process.execPath, ["--input-type=module", "--eval", runner], {
        env: { PATH: process.env.PATH },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  }
  function startNode(pairingToken?: string) {
    node = launchNode("node-data", "workspaces", pairingToken);
    return node;
  }
  const fixture = {
    directory,
    requests,
    pending,
    get control() {
      return control!;
    },
    get node() {
      return node!;
    },
    get origin() {
      return origin;
    },
    get cookie() {
      return cookie;
    },
    get nodeId() {
      return nodeId;
    },
    db<T>(read: (db: Database.Database) => T): T {
      const db = new Database(join(directory, "control-plane-data", "control-plane.sqlite"), {
        readonly: true,
        fileMustExist: true,
      });
      try {
        return read(db);
      } finally {
        db.close();
      }
    },
    async api(path: string, method = "GET", body?: unknown) {
      const response = await fetch(new URL(path, origin), {
        method,
        headers: { cookie, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(response.ok, `${method} ${path}: ${response.status}`).toBe(true);
      return response.status === 204 ? undefined : response.json();
    },
    async agent(
      name = "同事",
      model = { provider: "openai", id: "gpt-4o-mini" },
      targetNodeId = nodeId,
    ) {
      const created = await fixture.api("/api/owner/agents", "POST", {
        id: randomUUID(),
        nodeId: targetNodeId,
        name,
        role: "持续工作",
        description: "Synthetic fixture",
        model,
      });
      const direct = await fixture.api(
        `/api/owner/agents/${created.agent.id}/direct-channel`,
        "POST",
      );
      return {
        id: created.agent.id as string,
        channelId: direct.channel.id as string,
        workspace: created.agent.linuxIdentity.workspace as string,
      };
    },
    async send(channelId: string, text: string, extra: Record<string, unknown> = {}) {
      return fixture.api(`/api/owner/channels/${channelId}/messages`, "POST", { text, ...extra });
    },
    async completed(agentId: string) {
      return eventually(
        () =>
          fixture.db((db) => {
            const row = db
              .prepare(
                "SELECT id,state FROM owner_agent_runs WHERE agent_id=? ORDER BY rowid DESC LIMIT 1",
              )
              .get(agentId) as { id: string; state: string } | undefined;
            return row?.state === "completed" ? row.id : undefined;
          }),
        "completed run",
      );
    },
    async additionalNode() {
      const pairing = await fixture.api("/api/owner/nodes/pairing-tokens", "POST");
      const suffix = additionalNodes.length;
      const extraNode = launchNode(
        `extra-node-${suffix}`,
        `extra-workspaces-${suffix}`,
        pairing.pairingToken,
      );
      additionalNodes.push(extraNode);
      return (await extraNode.waitFor(/MATE_NODE_PAIRED ([0-9a-f-]+)/i))[1]!;
    },
    async restartControl() {
      const port = Number(new URL(origin).port);
      control!.child.kill("SIGKILL");
      await control!.exited;
      await startControl(port, false).waitFor(/MATE_CONTROL_PLANE_LISTENING (\d+)/);
      cookie = await login(origin);
    },
    async restartNode() {
      node!.child.kill("SIGKILL");
      await node!.exited;
      await startNode().waitFor(/MATE_NODE_CONNECTED/);
    },
    async stopNode() {
      await stopProcess(node);
    },
    async reconnectNode() {
      await startNode().waitFor(/MATE_NODE_CONNECTED/);
    },
    async close() {
      await stopProcess(node);
      for (const additional of additionalNodes) await stopProcess(additional);
      await stopProcess(control);
      for (const response of pending) response.destroy();
      provider.closeAllConnections();
      await new Promise<void>((done) => provider.close(() => done()));
      rmSync(directory, { recursive: true, force: true });
    },
  };
  try {
    await startControl()
      .waitFor(/MATE_CONTROL_PLANE_LISTENING (\d+)/)
      .then((match) => {
        origin = `http://127.0.0.1:${match[1]}`;
      });
    cookie = await login(origin);
    const pairing = await fixture.api("/api/owner/nodes/pairing-tokens", "POST");
    nodeId = (await startNode(pairing.pairingToken).waitFor(/MATE_NODE_PAIRED ([0-9a-f-]+)/i))[1]!;
    await fixture.api("/api/owner/model-credentials/openai", "PUT", {
      apiKey: "synthetic-control-only-key",
    });
    return fixture;
  } catch (error) {
    await fixture.close();
    throw error;
  }
}
