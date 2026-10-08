import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { NodeControlMessageSchema, type ControlWorkspaceOperation } from "@mate/protocol";
import {
  cleanupAgentToolFixture,
  setup,
  FakeNodeSocket,
} from "../support/agent/agent-tool-fixture.js";
import { bindToolSocket, toolTestInput } from "../support/agent/tool-run.js";

async function additionalNode(context: Awaited<ReturnType<typeof setup>>) {
  const response = await context.app.http.request("/api/owner/nodes/pairing-tokens", {
    method: "POST",
    headers: { cookie: context.cookie },
  });
  const { pairingToken } = z.object({ pairingToken: z.string() }).parse(await response.json());
  const nodeId = randomUUID();
  const socket = new FakeNodeSocket();
  const keys = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  context.app.nodes.open(socket);
  const challenge = NodeControlMessageSchema.parse(JSON.parse(socket.sent[0]!));
  if (challenge.type !== "control.challenge") throw new Error("Expected node challenge");
  bindToolSocket(context.app, nodeId, socket);
  await toolTestInput(
    context.app,
    socket,
    JSON.stringify({
      type: "node.pair",
      requestId: randomUUID(),
      nodeId,
      pairingToken,
      publicKey: keys.publicKey,
      signature: sign(null, Buffer.from(challenge.nonce), keys.privateKey).toString("base64url"),
    }),
  );
  return { nodeId, socket };
}

function workspaceRequest(): ControlWorkspaceOperation {
  return {
    type: "control.workspace.operation",
    requestId: randomUUID(),
    operationId: randomUUID(),
    agentId: randomUUID(),
    mode: "owner_read",
    operation: { kind: "workspace_stat", path: "report.txt" },
  };
}

function workspaceResult(request: ControlWorkspaceOperation) {
  return {
    type: "node.workspace.operation.result",
    requestId: request.requestId,
    operationId: request.operationId,
    agentId: request.agentId,
    ok: true,
    result: { code: 0, stdout: "{}", stderr: "", truncated: false },
  };
}

it("disconnect cancels all three request kinds on that node while another node still completes", async () => {
  const context = await setup();
  const peer = await additionalNode(context);
  const localFile = workspaceRequest();
  const peerFile = workspaceRequest();
  const cancelled = [
    context.app.nodes.provisionAgent(context.nodeId, randomUUID(), randomUUID(), () => {}),
    context.app.nodes.workspaceOperation(context.nodeId, localFile),
    context.app.nodes.executeAgentProcessOperation(context.nodeId, {
      operationId: randomUUID(),
      agentId: randomUUID(),
      operation: { kind: "process.list" },
    }),
  ].map((pending) => pending.catch((error: unknown) => error));
  const other = context.app.nodes.workspaceOperation(peer.nodeId, peerFile);
  let peerSettled = false;
  void other.then(() => {
    peerSettled = true;
  });
  context.app.nodes.close(context.socket);
  for (const failure of await Promise.all(cancelled))
    expect(failure).toMatchObject({ name: "NodeRequestError", code: "disconnected" });
  expect(peerSettled).toBe(false);
  await context.app.nodes.receive(peer.socket, JSON.stringify(workspaceResult(peerFile)));
  await expect(other).resolves.toMatchObject({ operationId: peerFile.operationId, ok: true });
});

it("duplicate completion leaves no old timeout able to reject a later request with that correlation ID", async () => {
  const context = await setup();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const first = workspaceRequest();
    const pending = context.app.nodes.workspaceOperation(context.nodeId, first);
    expect(context.app.nodes.workspaceOperation(context.nodeId, first)).toBe(pending);
    await vi.advanceTimersByTimeAsync(30_000);
    const result = workspaceResult(first);
    await context.app.nodes.receive(context.socket, JSON.stringify(result));
    await expect(pending).resolves.toMatchObject({ operationId: first.operationId });
    await context.app.nodes.receive(context.socket, JSON.stringify(result));
    const second = { ...workspaceRequest(), requestId: first.requestId };
    const next = context.app.nodes.workspaceOperation(context.nodeId, second);
    let settled = false;
    void next.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.advanceTimersByTimeAsync(30_001);
    expect(settled).toBe(false);
    await context.app.nodes.receive(context.socket, JSON.stringify(workspaceResult(second)));
    await expect(next).resolves.toMatchObject({ operationId: second.operationId, ok: true });
  } finally {
    vi.useRealTimers();
  }
});

afterEach(cleanupAgentToolFixture);
