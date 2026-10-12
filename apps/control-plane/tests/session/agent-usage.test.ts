import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  let networkEnded = false;
  const provider = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* drain request */
    }
    const usage = usages[requests++] ?? usages.at(-1)!;
    if (requests >= 8) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({ type: "response.created", response: { id: "partial" } })}\n\n`,
      );
      setTimeout(() => {
        response.destroy();
        networkEnded = true;
      }, 10);
      return;
    }
    if (requests === 7) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({
          type: "response.failed",
          response: {
            id: "failed-without-usage",
            status: "failed",
            error: { code: "invalid_request_error", message: "no usage supplied" },
            output: [],
          },
        })}\n\n`,
      );
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
            error: { code: "invalid_request_error", message: "synthetic failure" },
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
      `data: ${JSON.stringify({
        type: "response.completed",
        response: { id: `response-${requests}`, status: "completed", output, usage },
      })}\n\n`,
    );
  });
  await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("No provider port");
  let control: ProcessOutput | undefined;
  let node: ProcessOutput | undefined;
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
          .prepare<[string], { n: number }>(
            "SELECT COUNT(*) AS n FROM owner_agent_runs WHERE agent_id=? AND state='completed'",
          )
          .get(agentId)!;
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
    await api(`/api/owner/agents/${agentId}/model`, { provider: "openai", id: "gpt-4o" }, "PUT");
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
    await expect
      .poll(async () => (await api(usagePath, undefined, "GET")).normal.requestCount, {
        timeout: 15000,
        interval: 25,
      })
      .toBe(6);
    const failed = await api(usagePath, undefined, "GET");
    expect(failed.normal.requestCount).toBe(6);
    expect(failed.latestNormal.tokens.allInput.value).toBe(70);
    expect(failed.latestNormal.tokens.cacheRead.value).toBe(7);
    expect(failed.latestNormal.tokens.output.value).toBe(3);
    await api(`/api/owner/channels/${dm}/messages`, { text: "complete failure without usage" });
    await expect
      .poll(async () => (await api(usagePath, undefined, "GET")).normal.requestCount, {
        timeout: 15000,
        interval: 25,
      })
      .toBe(7);
    const noUsage = await api(usagePath, undefined, "GET");
    expect(noUsage.normal.requestCount).toBe(7);
    expect(noUsage.latestNormal.tokens.allInput.value).toBeNull();
    expect(noUsage.latestNormal.tokens.output.value).toBeNull();
    await api(`/api/owner/channels/${dm}/messages`, { text: "network failure before a response" });
    await expect.poll(() => networkEnded, { timeout: 15000 }).toBe(true);
    await api(`/api/owner/agents/${agentId}/pause`);
    await expect
      .poll(
        async () =>
          (await api(`/api/owner/agents/${agentId}/activity`, undefined, "GET")).stop.state,
        { timeout: 15000 },
      )
      .toBe("succeeded");
    const unconfirmed = await api(usagePath, undefined, "GET");
    expect(unconfirmed.normal.requestCount).toBe(7);
    expect(unconfirmed.latestNormal.id).toBe(noUsage.latestNormal.id);
  } finally {
    db?.close();
    await stopProcess(node);
    await stopProcess(control);
    provider.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

it.each(["before", "after"] as const)(
  "keeps usage atomic across a %s native response commit failure and restart",
  async (boundary) => {
    const { loopFixture, respond } = await import("../support/agent/agent-loop.js");
    let requests = 0;
    const fixture = await loopFixture(
      (_request, response) => {
        respond(response, "private response", { inputTokens: ++requests === 1 ? 100 : 200 });
      },
      `, ${boundary}DurableCommit: async writes => {
    if (writes.some(write => write.type === "entry" && write.value.kind === "pi.assistant")) {
      console.log("MATE_USAGE_COMMIT_FAILURE"); throw new Error("synthetic usage commit failure");
    }
  }`,
    );
    try {
      const agent = await fixture.agent();
      await fixture.send(agent.channelId, "Preserve atomic response observation");
      await fixture.control.waitFor(/MATE_USAGE_COMMIT_FAILURE/);
      await fixture.api(`/api/owner/agents/${agent.id}/pause`, "POST");
      const failed = await fixture.api(`/api/owner/agents/${agent.id}/usage`);
      expect(failed.normal.requestCount).toBe(boundary === "before" ? 0 : 1);
      expect(failed.normal.tokens.allInput.value).toBe(boundary === "before" ? null : 100);
      await fixture.restartControl();
      expect(await fixture.api(`/api/owner/agents/${agent.id}/usage`)).toEqual(failed);
      await expect
        .poll(
          async () =>
            (await fixture.api("/api/owner/nodes")).nodes.find(
              (node: { id: string; online: boolean }) => node.id === fixture.nodeId,
            )?.online,
          { timeout: 15000 },
        )
        .toBe(true);
      await fixture.api(`/api/owner/agents/${agent.id}/resume`, "POST");
      await fixture.completed(agent.id);
      const recovered = await fixture.api(`/api/owner/agents/${agent.id}/usage`);
      expect(recovered.normal.requestCount).toBe(1);
      expect(recovered.normal.tokens.allInput.value).toBe(boundary === "before" ? 200 : 100);
      expect(requests).toBe(boundary === "before" ? 2 : 1);
    } finally {
      await fixture.close();
    }
  },
  30000,
);

it.each(["restart", "network"] as const)(
  "counts a persisted nonzero streaming attempt as an unknown ordinary response after %s",
  async (interruption) => {
    const { loopFixture } = await import("../support/agent/agent-loop.js");
    const { anthropicReply } = await import("../support/provider/protocol-fixture.js");
    let requests = 0;
    let resumed: import("node:http").ServerResponse | undefined;
    let initial: import("node:http").ServerResponse | undefined;
    const fixture = await loopFixture(
      (_request, response) => {
        if (++requests > 1) {
          resumed = response;
          return;
        }
        initial = response;
        response.writeHead(200, { "content-type": "text/event-stream" });
        const events = [
          {
            type: "message_start",
            message: {
              id: "partial-usage",
              type: "message",
              role: "assistant",
              model: "claude-sonnet-4-5",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 25 },
            },
          },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "PRIVATE_NATIVE_PARTIAL_USAGE" },
          },
        ];
        for (const event of events)
          response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      },
      `, afterDurableCommit: async writes => {
      if (JSON.stringify(writes).includes("PRIVATE_NATIVE_PARTIAL_USAGE")) console.log("MATE_PARTIAL_USAGE_SAVED");
      if (writes.some(write => write.type === "entry" && write.value.kind === "pi.assistant" && write.value.model?.[0]?.stopReason === "error")) console.log("MATE_PARTIAL_USAGE_FAILED");
    }`,
    );
    try {
      await fixture.api("/api/owner/model-credentials/anthropic", "PUT", {
        apiKey: "synthetic-anthropic-key",
      });
      const agent = await fixture.agent("partial usage", {
        provider: "anthropic",
        id: "claude-sonnet-4-5",
      });
      await fixture.send(agent.channelId, "Preserve native partial spend across restart");
      await fixture.control.waitFor(/MATE_PARTIAL_USAGE_SAVED/);
      if (interruption === "network") {
        if (!initial) throw new Error("Missing initial provider stream");
        initial.destroy();
        await fixture.control.waitFor(/MATE_PARTIAL_USAGE_FAILED/);
      }
      await fixture.api(`/api/owner/agents/${agent.id}/pause`, "POST");
      await expect
        .poll(async () => (await fixture.api(`/api/owner/agents/${agent.id}/activity`)).stop.state)
        .toBe("succeeded");
      await fixture.restartControl();
      await expect
        .poll(
          async () =>
            (await fixture.api("/api/owner/nodes")).nodes.find(
              (node: { id: string; online: boolean }) => node.id === fixture.nodeId,
            )?.online,
        )
        .toBe(true);
      await fixture.api(`/api/owner/agents/${agent.id}/resume`, "POST");
      await expect.poll(() => resumed).toBeDefined();
      const partial = await fixture.api(`/api/owner/agents/${agent.id}/usage`);
      expect(partial.normal.requestCount).toBe(1);
      expect(partial.latestNormal.tokens.uncachedInput).toEqual({
        value: null,
        knownRequests: 0,
        missingRequests: 1,
      });
      expect(partial.total.tokens.allInput.value).toBeNull();
      expect(partial.normal.cacheHitRate.value).toBeNull();
      if (!resumed) throw new Error("Missing resumed provider request");
      anthropicReply(resumed, { text: "resumed privately" });
      await fixture.completed(agent.id);
      const usage = await fixture.api(`/api/owner/agents/${agent.id}/usage`);
      expect(requests).toBe(2);
      expect(usage.normal.requestCount).toBe(2);
      expect(usage.normal.tokens.uncachedInput).toEqual({
        value: 20,
        knownRequests: 1,
        missingRequests: 1,
      });
      expect(usage.total.tokens.uncachedInput).toEqual(usage.normal.tokens.uncachedInput);
      expect(usage.summary.requestCount).toBe(0);
      expect(usage.latestNormal.tokens.uncachedInput.value).toBe(20);
      expect(usage.normal.cacheHitRate.value).toBeNull();
      expect(
        JSON.stringify(await fixture.api(`/api/owner/agents/${agent.id}/activity?detail=1`)),
      ).not.toContain("PRIVATE_NATIVE_PARTIAL_USAGE");
      await fixture.restartControl();
      expect(await fixture.api(`/api/owner/agents/${agent.id}/usage`)).toEqual(usage);
    } finally {
      await fixture.close();
    }
  },
  30000,
);

it("commits a terminal SSE response without waiting for the provider HTTP body to end", async () => {
  const { loopFixture } = await import("../support/agent/agent-loop.js");
  let providerResponse: import("node:http").ServerResponse | undefined;
  const fixture = await loopFixture((_request, response) => {
    providerResponse = response;
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const [delta, finishReason] of [
      [{ role: "assistant", content: "private completed response" }, null],
      [{}, "stop"],
    ]) {
      response.write(
        `data: ${JSON.stringify({ id: "terminal-open-body", object: "chat.completion.chunk", created: 1, model: "deepseek-flash", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
      );
    }
    response.write(
      `data: ${JSON.stringify({ id: "terminal-open-body", object: "chat.completion.chunk", created: 1, model: "deepseek-flash", choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 20 } } })}\n\n`,
    );
    response.write("data: [DONE]\n\n");
    // A protocol-complete response is usable even while its HTTP body remains open.
  });
  try {
    await fixture.api("/api/owner/model-credentials/deepseek", "PUT", {
      apiKey: "synthetic-deepseek-key",
    });
    const agent = await fixture.agent("terminal stream", {
      provider: "deepseek",
      id: "deepseek-flash",
    });
    await fixture.send(agent.channelId, "Complete at the terminal SSE frame");
    await expect
      .poll(
        async () => (await fixture.api(`/api/owner/agents/${agent.id}/usage`)).normal.requestCount,
        { timeout: 3000 },
      )
      .toBe(1);
    const usage = await fixture.api(`/api/owner/agents/${agent.id}/usage`);
    expect(usage.latestNormal.tokens.allInput.value).toBe(100);
    expect(usage.latestNormal.tokens.output.value).toBe(10);
    expect(usage.latestNormal.cacheHitRate.value).toBe(0.2);
    expect(providerResponse?.writableEnded).toBe(false);
    expect(fixture.requests).toHaveLength(1);
    expect(
      (await fixture.api(`/api/owner/channels/${agent.channelId}/messages`)).messages,
    ).toHaveLength(1);
  } finally {
    await fixture.close();
  }
}, 30000);
