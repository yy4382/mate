import { expect, it } from "vitest";
import { loopFixture } from "../helpers/agent-loop.js";
import { eventually } from "../helpers/run-services.js";

it("the real Google SDK adapter uses the local endpoint and preserves unknown cache fields", async () => {
  let turn = 0;
  const fixture = await loopFixture((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({ responseId: `google-synthetic-response-${turn}`, candidates: [{ content: { role: "model", parts: [{ text: "Google正文仅保留在会话。" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, totalTokenCount: 110, ...(turn++ ? { cachedContentTokenCount: 30 } : {}) } })}\n\n`,
    );
  });
  try {
    await fixture.api("/api/owner/model-credentials/google", "PUT", {
      apiKey: "synthetic-google-key",
    });
    const agent = await fixture.agent("Google同事", { provider: "google", id: "gemini-2.5-flash" });
    await fixture.send(agent.channelId, "检查SDK路径。");
    await fixture.completed(agent.id);
    const usage = await fixture.api(`/api/owner/agents/${agent.id}/usage`);
    expect(usage.normal.requestCount).toBe(1);
    expect(usage.normal.tokens.allInput.value).toBe(100);
    expect(usage.normal.tokens.output.value).toBe(10);
    expect(usage.normal.tokens.cacheRead.value).toBeNull();
    expect(usage.normal.cacheHitRate.value).toBeNull();
    expect(
      (await fixture.api(`/api/owner/channels/${agent.channelId}/messages`)).messages,
    ).toHaveLength(1);
    await fixture.send(agent.channelId, "Google已报告的缓存值");
    await eventually(
      () =>
        fixture.db(
          (db) =>
            db
              .prepare(
                "SELECT COUNT(*) AS n FROM owner_agent_runs WHERE agent_id=? AND state='completed'",
              )
              .get(agent.id) as any,
        )?.n === 2
          ? true
          : undefined,
      "second Google run",
    );
    const cached = await fixture.api(`/api/owner/agents/${agent.id}/usage`);
    expect(cached.normal.tokens.allInput.value).toBe(200);
    expect(cached.latestNormal.tokens.cacheRead.value).toBe(30);
    expect(cached.latestNormal.cacheHitRate.value).toBe(0.3);
  } finally {
    await fixture.close();
  }
}, 30000);

it("the real Google SDK credential rejection pauses without treating its normalized usage as evidence", async () => {
  const fixture = await loopFixture((_request, response) => {
    response.writeHead(403, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: {
          code: 403,
          status: "PERMISSION_DENIED",
          message: "Synthetic credential rejection",
        },
      }),
    );
  });
  try {
    await fixture.api("/api/owner/model-credentials/google", "PUT", {
      apiKey: "synthetic-google-key",
    });
    const agent = await fixture.agent("Google同事", { provider: "google", id: "gemini-2.5-flash" });
    await fixture.send(agent.channelId, "保持未处理。");
    await eventually(
      () =>
        fixture.db(
          (db) =>
            db
              .prepare("SELECT paused_reason FROM owner_agent_run_control WHERE agent_id=?")
              .get(agent.id) as any,
        )?.paused_reason === "credentials"
          ? true
          : undefined,
      "Google credential pause",
    );
    expect((await fixture.api(`/api/owner/agents/${agent.id}/usage`)).normal.requestCount).toBe(0);
  } finally {
    await fixture.close();
  }
}, 30000);
