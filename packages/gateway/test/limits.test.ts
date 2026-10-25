import { randomUUID } from "node:crypto";
import { onTestFinished, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { FakeNode } from "@mate/testkit";
import {
  eventually,
  never,
  newIdentity,
  startGateway,
  text,
  toolResult,
  within,
} from "./support.ts";

/** A connection that speaks raw frames, recording what the gateway sends and how it closes. */
async function rawConnection(url: string) {
  const socket = new WebSocket(url);
  onTestFinished(() => socket.terminate());
  const received: Array<{ type: string; code?: string; nonce?: string; requestId?: string }> = [];
  const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
  socket.on("message", (data) => received.push(JSON.parse(String(data))));
  socket.on("error", () => {});
  await new Promise<void>((resolve) => {
    socket.once("open", () => resolve());
    socket.once("close", () => resolve());
  });
  return { socket, received, closed };
}

const MESSAGE_LIMIT_BYTES = 1024 * 1024;

/** A well-formed authenticate request for an unknown node, padded to `bytes` once serialized. */
function authenticateOfSize(bytes: number, pad: string): string {
  const base = { type: "node.authenticate", requestId: "r1", nodeId: randomUUID(), signature: "s" };
  const empty = Buffer.byteLength(JSON.stringify({ ...base, pad: "" }));
  const unit = Buffer.byteLength(pad);
  const message = JSON.stringify({ ...base, pad: pad.repeat(Math.ceil((bytes - empty) / unit)) });
  return message;
}

describe("node gateway limits (MODULE_TESTS 7)", () => {
  it("refuses unauthenticated connections beyond the limit, and takes new ones once a slot frees up", async () => {
    const under = await startGateway({ maxUnauthenticated: 2 });
    const first = await rawConnection(under.url);
    const second = await rawConnection(under.url);
    const third = await rawConnection(under.url);
    expect(await within(third.closed), "the third waiting connection is closed").toBe(1013);
    expect(third.received, "it is not even challenged").toEqual([]);
    expect(first.received.map((m) => m.type)).toEqual(["gateway.challenge"]);
    expect(second.received.map((m) => m.type)).toEqual(["gateway.challenge"]);

    first.socket.close();
    await first.closed;
    const node = new FakeNode({
      gatewayUrl: under.url,
      ...newIdentity(),
      pairingToken: under.gateway.createPairingToken().pairingToken,
    });
    await node.connect();
    expect(node.isAuthenticated, "a closed connection frees its slot").toBe(true);
    const fourth = await rawConnection(under.url);
    expect(
      await within(fourth.closed, 200),
      "an authenticated connection no longer counts against the limit",
    ).toBe("pending");
    node.close();
  });

  it("closes a connection whose message is larger than the limit once serialized, and keeps one just under it", async () => {
    const under = await startGateway();
    const under_limit = await rawConnection(under.url);
    under_limit.socket.send(authenticateOfSize(MESSAGE_LIMIT_BYTES - 64, "é"));
    expect(await within(under_limit.closed, 300), "a message under the limit is read").toBe(
      "pending",
    );
    expect(under_limit.received.map((m) => m.code ?? m.type)).toEqual([
      "gateway.challenge",
      "unknown_identity",
    ]);

    // Two bytes per character: over the limit in bytes though not in characters.
    const over = await rawConnection(under.url);
    over.socket.send(authenticateOfSize(MESSAGE_LIMIT_BYTES + 64, "é"));
    expect(await within(over.closed), "a message over the limit closes the connection").not.toBe(
      "pending",
    );
    expect(
      over.received.map((m) => m.type),
      "it is not answered",
    ).toEqual(["gateway.challenge"]);
  });

  it.each([
    ["text that is not JSON", () => "{not json"],
    ["JSON that is not a node message", () => JSON.stringify({ type: "node.unknown" })],
    [
      "a tool result before authenticating",
      () =>
        JSON.stringify({
          type: "node.tool.result",
          requestId: "r1",
          content: [{ type: "text", text: "x" }],
          isError: false,
        }),
    ],
    ["a ping before authenticating", () => JSON.stringify({ type: "node.ping", requestId: "r1" })],
  ])("closes a connection that sends %s", async (_, frame) => {
    const under = await startGateway();
    const connection = await rawConnection(under.url);
    connection.socket.send(frame());
    expect(await within(connection.closed)).toBe(1008);
  });

  it("ends a connection that does not authenticate in time with a protocol error, not a refusal of its identity", async () => {
    const under = await startGateway();
    const connection = await rawConnection(under.url);
    await eventually(() => connection.received.length === 1, "challenged");
    under.clock.advance(10_000);
    expect(await within(connection.closed)).toBe(1008);
    expect(connection.received.map((m) => `${m.type} ${m.code ?? ""}`.trim())).toEqual([
      "gateway.challenge",
      "gateway.error handshake_timeout",
    ]);
  });

  it("closes an authenticated connection that tries to authenticate again, and reads nothing it sends after that", async () => {
    const under = await startGateway();
    const paired = await under.pairedNode();
    paired.close();
    await paired.closed();

    const connection = await rawConnection(under.url);
    await eventually(() => connection.received.length === 1, "challenged");
    const authenticate = JSON.stringify({
      type: "node.authenticate",
      requestId: "r1",
      nodeId: paired.nodeId,
      signature: paired.sign(connection.received[0]!.nonce!),
    });
    connection.socket.send(authenticate);
    await eventually(() => under.gateway.status(paired.nodeId).online, "authenticated");
    const call = under.gateway.runTool(
      paired.nodeId,
      "agent-1",
      { access: "home", tool: "bash", arguments: { command: "sleep 60" } },
      () => {},
      never,
    );
    await eventually(() => connection.received.length === 3, "the call reached the node");
    const { requestId } = connection.received[2]!;

    connection.socket.send(authenticate);
    connection.socket.send(
      JSON.stringify({ type: "node.tool.result", requestId, ...toolResult("too late") }),
    );
    expect(await within(connection.closed), "the connection is closed").toBe(1008);
    expect(under.gateway.status(paired.nodeId).online).toBe(false);
    expect(text(await call), "the result sent after the violation is not read").toMatch(/unknown/i);
  });
});
