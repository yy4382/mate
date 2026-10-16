import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deferred, eventually, never, startGateway, text, toolResult, within } from "./support.ts";

describe("node gateway tool calls (MODULE_TESTS 7)", () => {
  it("streams a call's output to the caller and then returns its result", async () => {
    const under = await startGateway();
    const node = await under.pairedNode({
      onRunTool: async () => ({ outputs: ["hello ", "world"], result: toolResult("done") }),
    });
    const chunks: string[] = [];
    const result = await under.gateway.runTool(
      node.nodeId,
      "agent-1",
      { requestId: randomUUID(), tool: "bash", arguments: { command: "echo hello world" } },
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
        { requestId: randomUUID(), tool: "bash", arguments: { command: "echo hi" } },
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
      { requestId: randomUUID(), tool: "bash", arguments: { command: "sleep 60" } },
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
      { requestId: randomUUID(), tool: "bash", arguments: { command: "echo next" } },
      () => {},
      never,
    );
    await eventually(() => arrived.length === 2, "the next call reached the node");
    node.send({ type: "node.tool.result", requestId: arrived[1]!, ...toolResult("next") });
    expect(await next, "the reconnected node still answers new calls").toEqual(toolResult("next"));
    expect(chunks, "the late output never reached the caller").toEqual([]);
    expect(await call, "the caller's answer stays unknown").toEqual(result);
  });

  it("ends a call as unknown when its caller aborts it, and drops what the node sends for it afterwards", async () => {
    const under = await startGateway();
    const callArrived = deferred<string>();
    const node = await under.pairedNode({
      onRunTool: (message) => {
        callArrived.resolve(message.requestId);
        return new Promise(() => {});
      },
    });
    const abort = new AbortController();
    const chunks: string[] = [];
    const call = under.gateway.runTool(
      node.nodeId,
      "agent-1",
      { requestId: randomUUID(), tool: "bash", arguments: { command: "sleep 60" } },
      (chunk) => chunks.push(chunk),
      abort.signal,
    );
    const requestId = await callArrived.promise;
    abort.abort();
    expect(text(await within(call))).toMatch(/unknown/i);

    node.send({ type: "node.tool.output", requestId, chunk: "late output" });
    node.send({ type: "node.tool.result", requestId, ...toolResult("late result") });
    node.ping();
    await eventually(() => node.pongs > 0, "the node's later messages were read");
    expect(chunks, "output after the call ended is dropped").toEqual([]);
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
      { requestId: randomUUID(), tool: "bash", arguments: { command: "echo hi" } },
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
