import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeNode } from "@mate/testkit";
import { deferred, eventually, never, startGateway, text, toolResult, within } from "./support.ts";

describe("node gateway connections (MODULE_TESTS 7)", () => {
  it("lets a paired node back in by its signature alone, without a pairing token", async () => {
    const under = await startGateway();
    const paired = await under.pairedNode();
    paired.close();
    await paired.closed();

    const again = new FakeNode({ gatewayUrl: under.url, nodeId: paired.nodeId, sign: paired.sign });
    await again.connect();
    expect(under.gateway.status(paired.nodeId).online).toBe(true);
    again.close();
  });

  it("closes the old connection when the same node connects again, and nothing sent on the old one reaches a caller", async () => {
    const under = await startGateway();
    const oldCallArrived = deferred();
    const old = await under.pairedNode({
      onRunTool: () => {
        oldCallArrived.resolve();
        return new Promise(() => {});
      },
    });
    const onOld: string[] = [];
    const callOnOld = under.gateway.runTool(
      old.nodeId,
      "agent-1",
      { access: "home", tool: "bash", arguments: { command: "sleep 60" } },
      (chunk) => onOld.push(chunk),
      never,
    );
    await oldCallArrived.promise;

    const replacementCallArrived = deferred<string>();
    const replacement = new FakeNode({
      gatewayUrl: under.url,
      nodeId: old.nodeId,
      sign: old.sign,
      onRunTool: (message) => {
        replacementCallArrived.resolve(message.requestId);
        return new Promise(() => {});
      },
    });
    await replacement.connect();

    expect(await within(old.closed()), "the gateway closed the old connection").toBeUndefined();
    expect(
      text(await within(callOnOld)),
      "the call the old connection carried has no answer any more",
    ).toMatch(/unknown/i);

    const onNew: string[] = [];
    const callOnNew = under.gateway.runTool(
      old.nodeId,
      "agent-1",
      { access: "home", tool: "bash", arguments: { command: "echo new" } },
      (chunk) => onNew.push(chunk),
      never,
    );
    const requestId = await replacementCallArrived.promise;
    const lateOutput = { type: "node.tool.output", requestId, chunk: "from old" } as const;
    const lateResult = { type: "node.tool.result", requestId, ...toolResult("from old") } as const;
    expect(
      old.send(lateOutput) || old.send(lateResult),
      "the old connection can send nothing",
    ).toBe(false);
    replacement.send({ type: "node.tool.output", requestId, chunk: "from new" });
    replacement.send({ type: "node.tool.result", requestId, ...toolResult("from new") });
    expect(text(await within(callOnNew))).toBe("from new");
    expect(onNew).toEqual(["from new"]);
    expect(onOld, "nothing reached the old call's caller").toEqual([]);
  });

  it("declares a node offline once its connection is blackholed for the heartbeat timeout, though the node keeps pinging", async () => {
    const under = await startGateway({ heartbeatTimeoutMs: 5_000 });
    const callArrived = deferred();
    const node = await under.pairedNode({
      gatewayUrl: under.proxyUrl,
      onRunTool: () => {
        callArrived.resolve();
        return new Promise(() => {});
      },
    });
    const call = under.gateway.runTool(
      node.nodeId,
      "agent-1",
      { access: "home", tool: "bash", arguments: { command: "sleep 60" } },
      () => {},
      never,
    );
    await callArrived.promise;

    under.proxy.setMode("blackhole");
    for (let elapsed = 0; elapsed < 4_000; elapsed += 1_000) {
      expect(node.send({ type: "node.ping", requestId: randomUUID() }), "the TCP link is up").toBe(
        true,
      );
      under.clock.advance(1_000);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(under.gateway.status(node.nodeId).online, "4s of silence is within the timeout").toBe(
      true,
    );

    node.send({ type: "node.ping", requestId: randomUUID() });
    under.clock.advance(1_000);
    await eventually(
      () => !under.gateway.status(node.nodeId).online,
      "5s without a ping getting through takes the node offline",
    );
    expect(text(await within(call)), "the call it carried ends as unknown").toMatch(/unknown/i);
    const after = await under.gateway.runTool(
      node.nodeId,
      "agent-1",
      { access: "home", tool: "bash", arguments: { command: "echo hi" } },
      () => {},
      never,
    );
    expect(text(after)).toMatch(/offline/i);
  });

  it("keeps a node online for as long as its pings arrive within the heartbeat timeout", async () => {
    const under = await startGateway({ heartbeatTimeoutMs: 5_000 });
    const node = await under.pairedNode({ gatewayUrl: under.proxyUrl });

    for (let i = 0; i < 4; i++) {
      under.clock.advance(4_000);
      node.ping();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(
      under.gateway.status(node.nodeId).online,
      "16s have passed, but never 5s without a ping",
    ).toBe(true);
  });
});
