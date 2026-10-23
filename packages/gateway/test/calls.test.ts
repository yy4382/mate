import { getEventListeners } from "node:events";
import type { GatewayRunTool, ToolResult } from "@mate/node-protocol";
import { describe, expect, it } from "vitest";
import { deferred, eventually, never, startGateway, text, toolResult, within } from "./support.ts";

describe("node gateway tool calls (MODULE_TESTS 7)", () => {
  it.each(["home", "visit"] as const)(
    "sends %s access unchanged over the WebSocket",
    async (access) => {
      const under = await startGateway();
      const arrived: GatewayRunTool[] = [];
      const node = await under.pairedNode({
        onRunTool: async (message) => {
          arrived.push(message);
          return { outputs: [], result: toolResult("done") };
        },
      });
      const request = { access, tool: "bash" as const, arguments: { command: "echo hello" } };
      expect(await under.gateway.runTool(node.nodeId, "agent-1", request, () => {}, never)).toEqual(
        toolResult("done"),
      );
      expect(arrived).toEqual([
        { type: "gateway.run.tool", requestId: expect.any(String), agentId: "agent-1", ...request },
      ]);
    },
  );

  it("refuses a call without access before sending it or listening on its signal", async () => {
    const under = await startGateway();
    const arrived: GatewayRunTool[] = [];
    const node = await under.pairedNode({
      onRunTool: async (message) => {
        arrived.push(message);
        return { outputs: [], result: toolResult("ran") };
      },
    });
    const signal = new AbortController().signal;
    await expect(
      under.gateway.runTool(
        node.nodeId,
        "agent-1",
        // @ts-expect-error JavaScript callers can omit access; the boundary must still reject it.
        { tool: "bash", arguments: { command: "echo" } },
        () => {},
        signal,
      ),
    ).rejects.toThrow();
    expect(getEventListeners(signal, "abort")).toEqual([]);
    node.ping();
    await eventually(() => node.pongs > 0, "the gateway has sent everything it would");
    expect(arrived).toEqual([]);
  });

  it("streams a call's output to the caller and then returns its result", async () => {
    const under = await startGateway();
    const node = await under.pairedNode({
      onRunTool: async () => ({ outputs: ["hello ", "world"], result: toolResult("done") }),
    });
    const chunks: string[] = [];
    const result = await under.gateway.runTool(
      node.nodeId,
      "agent-1",
      { access: "home", tool: "bash", arguments: { command: "echo hello world" } },
      (chunk) => chunks.push(chunk),
      never,
    );
    expect(chunks).toEqual(["hello ", "world"]);
    expect(result).toEqual(toolResult("done"));
  });

  it("returns node offline at once, without waiting, when the node is not connected", async () => {
    const under = await startGateway();
    const node = await under.pairedNode();
    node.close();
    await eventually(() => !under.gateway.status(node.nodeId).online, "the node went offline");

    const result = await within(
      under.gateway.runTool(
        node.nodeId,
        "agent-1",
        { access: "home", tool: "bash", arguments: { command: "echo hi" } },
        () => {},
        never,
      ),
      200,
    );
    expect(text(result)).toMatch(/offline/i);
  });

  it("ends a call cut off by a lost connection as unknown at once, and discards its result when the node reconnects and sends it", async () => {
    const under = await startGateway();
    const arrived: string[] = [];
    const node = await under.pairedNode({
      gatewayUrl: under.proxyUrl,
      onRunTool: (message) => {
        arrived.push(message.requestId);
        return new Promise(() => {});
      },
    });
    const chunks: string[] = [];
    const call = under.gateway.runTool(
      node.nodeId,
      "agent-1",
      { access: "home", tool: "bash", arguments: { command: "sleep 60" } },
      (chunk) => chunks.push(chunk),
      never,
    );
    await eventually(() => arrived.length === 1, "the call reached the node");
    const [cutOff] = arrived;

    under.proxy.setMode("disconnect");
    const result = await within(call);
    expect(text(result), "no clock time passes before the call ends").toMatch(/unknown/i);
    expect(text(result), "the caller is told it was not retried").toMatch(/not retried/i);
    expect(under.gateway.status(node.nodeId).online).toBe(false);

    under.proxy.setMode("forward");
    await node.connect();
    expect(under.gateway.status(node.nodeId).online, "the node is back").toBe(true);
    node.send({ type: "node.tool.output", requestId: cutOff!, chunk: "late output" });
    node.send({ type: "node.tool.result", requestId: cutOff!, ...toolResult("late result") });

    const next = under.gateway.runTool(
      node.nodeId,
      "agent-1",
      { access: "home", tool: "bash", arguments: { command: "echo next" } },
      () => {},
      never,
    );
    await eventually(() => arrived.length === 2, "the next call reached the node");
    node.send({ type: "node.tool.result", requestId: arrived[1]!, ...toolResult("next") });
    expect(await next, "the reconnected node still answers new calls").toEqual(toolResult("next"));
    expect(chunks, "the late output never reached the caller").toEqual([]);
    expect(await call, "the caller's answer stays unknown").toEqual(result);
  });

  it.each(["home", "visit"] as const)(
    "stops a %s call on its node when its caller aborts, ends it at once as stopped, and drops what the node sends for it afterwards",
    async (access) => {
      const under = await startGateway();
      const callArrived = deferred<string>();
      const stopArrived = deferred<string>();
      const node = await under.pairedNode({
        onRunTool: (message) => {
          callArrived.resolve(message.requestId);
          return new Promise(() => {});
        },
        onStopTool: (requestId) => stopArrived.resolve(requestId),
      });
      const abort = new AbortController();
      const chunks: string[] = [];
      const call = under.gateway.runTool(
        node.nodeId,
        "agent-1",
        { access, tool: "bash", arguments: { command: "sleep 60" } },
        (chunk) => chunks.push(chunk),
        abort.signal,
      );
      const requestId = await callArrived.promise;
      abort.abort();
      const result = await within(call);
      expect(text(result)).toMatch(/stopped/i);
      expect(text(result), "the connection is fine; the caller is not told otherwise").not.toMatch(
        /connection/i,
      );
      expect(await within(stopArrived.promise), "the node is told to stop that call").toBe(
        requestId,
      );

      node.send({ type: "node.tool.output", requestId, chunk: "late output" });
      node.send({ type: "node.tool.result", requestId, ...toolResult("late result") });
      node.ping();
      await eventually(() => node.pongs > 0, "the node's later messages were read");
      expect(chunks, "output after the call ended is dropped").toEqual([]);
      expect(under.gateway.status(node.nodeId).online, "the node stays online").toBe(true);
    },
  );

  it("gives each call its own request ID, so concurrent calls of two Agents each get their own output and result", async () => {
    const under = await startGateway();
    const arrived: GatewayRunTool[] = [];
    const node = await under.pairedNode({
      onRunTool: async (message) => {
        arrived.push(message);
        // Answer only once both calls are on the node, so each answer races the other.
        await eventually(() => arrived.length === 2, "both calls reached the node");
        return {
          outputs: [`out ${message.agentId}`],
          result: toolResult(`result ${message.agentId}`),
        };
      },
    });
    const run = (agentId: string, chunks: string[]) =>
      under.gateway.runTool(
        node.nodeId,
        agentId,
        { access: "home", tool: "bash", arguments: { command: "echo" } },
        (chunk) => chunks.push(chunk),
        never,
      );
    const aChunks: string[] = [];
    const bChunks: string[] = [];
    const [a, b] = await Promise.all([
      within(run("agent-a", aChunks)),
      within(run("agent-b", bChunks)),
    ]);
    expect(text(a)).toBe("result agent-a");
    expect(text(b)).toBe("result agent-b");
    expect(aChunks).toEqual(["out agent-a"]);
    expect(bChunks).toEqual(["out agent-b"]);
    expect(new Set(arrived.map((m) => m.requestId)).size, "two different request IDs").toBe(2);
  });

  it("returns the node's result however long a call runs: a call has no deadline of its own", async () => {
    const day = 24 * 60 * 60_000;
    const under = await startGateway({ heartbeatTimeoutMs: 30 * day });
    const answer = deferred<{ outputs: string[]; result: ToolResult }>();
    const node = await under.pairedNode({ onRunTool: () => answer.promise });
    const call = under.gateway.runTool(
      node.nodeId,
      "agent-1",
      { access: "home", tool: "bash", arguments: { command: "make world" } },
      () => {},
      never,
    );
    under.clock.advance(day);
    expect(await within(call, 100), "a day later the call still waits for the node").toBe(
      "pending",
    );
    answer.resolve({ outputs: [], result: toolResult("built") });
    expect(await within(call)).toEqual(toolResult("built"));
  });

  it("refuses a call with an invalid Agent ID before sending it or listening on its signal", async () => {
    const under = await startGateway();
    const arrived: string[] = [];
    const node = await under.pairedNode({
      onRunTool: async (message) => {
        arrived.push(message.agentId);
        return { outputs: [], result: toolResult("ran") };
      },
    });
    const signal = new AbortController().signal;
    await expect(
      under.gateway.runTool(
        node.nodeId,
        "../escape",
        { access: "home", tool: "bash", arguments: { command: "echo" } },
        () => {},
        signal,
      ),
    ).rejects.toThrow();
    expect(getEventListeners(signal, "abort"), "nothing is left listening").toEqual([]);
    node.ping();
    await eventually(() => node.pongs > 0, "the gateway has sent everything it would");
    expect(arrived, "nothing reached the node").toEqual([]);
  });

  it("takes a call's output and result only from the node that carries it, and keeps it running when another node disconnects", async () => {
    const under = await startGateway();
    const leaving = await under.pairedNode();
    const callArrived = deferred<string>();
    const staying = await under.pairedNode({
      onRunTool: (message) => {
        callArrived.resolve(message.requestId);
        return new Promise(() => {});
      },
    });
    const chunks: string[] = [];
    const call = under.gateway.runTool(
      staying.nodeId,
      "agent-1",
      { access: "home", tool: "bash", arguments: { command: "echo hi" } },
      (chunk) => chunks.push(chunk),
      never,
    );
    const requestId = await callArrived.promise;

    leaving.send({ type: "node.tool.output", requestId, chunk: "from the other node" });
    leaving.send({ type: "node.tool.result", requestId, ...toolResult("from the other node") });
    leaving.ping();
    await eventually(() => leaving.pongs > 0, "the gateway read the other node's messages");
    leaving.terminate();
    await eventually(() => !under.gateway.status(leaving.nodeId).online, "the other node left");
    expect(await within(call, 100), "the other node cannot answer it").toBe("pending");

    staying.send({ type: "node.tool.output", requestId, chunk: "hi" });
    staying.send({ type: "node.tool.result", requestId, ...toolResult("ok") });
    expect(await call).toEqual(toolResult("ok"));
    expect(chunks).toEqual(["hi"]);
  });
});
