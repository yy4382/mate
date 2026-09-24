import { afterEach, expect, it } from "vitest";
import { Store } from "../../src/storage/store.js";
import { slackApplication } from "../../src/slack/application.js";
import { CanonicalSlackTransport, SlackNotReadyError } from "../../src/slack/transport.js";
import {
  classifySlackFailure,
  missingCredentialFailure,
  readSlackReadiness,
  recordSlackReadiness,
  slackReady,
  slackWaitReason,
  SlackOperatorActionError,
  type SlackReadiness,
} from "../../src/slack/readiness.js";
import { configFixture } from "../helpers/config.js";
import type { MateConfig } from "../../src/config.js";
import { configSchema } from "../../src/config.js";
import { Collaboration } from "../../src/collaboration/service.js";
import { CanonicalAttention } from "../../src/conversations/attention.js";
import { CanonicalFreshnessGate } from "../../src/conversations/freshness.js";
import { Messages, Output, fixtureTarget } from "../helpers/canonical-slack.js";
import type { CanonicalArtifactTransport } from "../../src/conversations/output.js";
const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
function snapshot(state: "ready" | "waiting" | "needs-human", action?: string): SlackReadiness {
  return {
    updatedAt: 7,
    installations: [
      {
        agentId: "research",
        state,
        reason: state === "ready" ? "connected" : "invalid_auth",
        ...(action ? { action } : {}),
        attempts: 1,
        changedAt: 3,
      },
    ],
  };
}
it("separates a temporary failure from a problem only a human can fix", () => {
  expect(
    classifySlackFailure(
      { code: "slack_webapi_platform_error", data: { error: "invalid_auth" } },
      "research",
    ),
  ).toEqual({
    state: "needs-human",
    reason: "invalid_auth",
    action:
      "Replace the Slack tokens of research in the Mate service environment, then restart Mate.",
  });
  expect(
    classifySlackFailure(
      { code: "slack_webapi_platform_error", data: { error: "missing_scope" } },
      "research",
    ),
  ).toMatchObject({ state: "needs-human", reason: "missing_scope" });
  expect(classifySlackFailure(new Error("socket hang up"), "research")).toEqual({
    state: "waiting",
    reason: "connection_unavailable",
  });
  expect(
    classifySlackFailure({ code: "slack_webapi_rate_limited_error", retryAfter: 30 }, "research"),
  ).toEqual({ state: "waiting", reason: "rate_limited", retryAfterMs: 30000 });
  expect(
    missingCredentialFailure("research", ["RESEARCH_BOT_TOKEN", "RESEARCH_APP_TOKEN"]),
  ).toEqual({
    state: "needs-human",
    reason: "missing_credentials",
    action:
      "Set RESEARCH_BOT_TOKEN, RESEARCH_APP_TOKEN for research in the Mate service environment, then restart Mate.",
  });
  expect(new SlackOperatorActionError({ state: "waiting", reason: "x" }).failure.reason).toBe("x");
});
it("keeps a not-ready installation out of every platform boundary and reports why", () => {
  const store = new Store(":memory:");
  stores.push(store);
  const transport = new CanonicalSlackTransport(
    store,
    slackApplication(store, configFixture).mapper,
    {
      research: "synthetic",
    },
  );
  expect(transport.readyFor("research")).toBe(true);
  expect(transport.waitingFor("research")).toBeUndefined();
  expect(transport.readyAgents()).toEqual(["research"]);
  transport.setReadiness(snapshot("needs-human", "Replace the tokens"));
  expect(transport.readyFor("research")).toBe(false);
  expect(transport.readyAgents()).toEqual([]);
  expect(transport.waitingFor("research")).toBeInstanceOf(SlackNotReadyError);
  expect(transport.waitingFor("research")!.reason).toContain("needs an operator");
  expect(transport.waitingFor("research")!.reason).toContain("Replace the tokens");
  // Nothing crossed the boundary, so the durable record waits instead of reporting an unknown.
  expect(transport.classify(transport.waitingFor("research"))).toEqual({
    kind: "retry",
    afterMs: 5000,
  });
  return expect(
    transport.post({
      id: "outbox-1",
      actor: "research",
      target: { conversationId: "CTEST" },
      text: "body",
      requestHash: "hash",
      originalRequest: "{}",
    }),
  ).rejects.toThrow("Slack is not ready");
});
it("persists the readiness an owner view reads without constructing Slack", () => {
  const store = new Store(":memory:");
  stores.push(store);
  expect(readSlackReadiness(store)).toBeNull();
  recordSlackReadiness(store, snapshot("waiting"));
  expect(readSlackReadiness(store)).toEqual(snapshot("waiting"));
  expect(slackReady(snapshot("waiting"), "research")).toBe(false);
  expect(slackWaitReason(snapshot("waiting"), "research")).toContain("waiting to recover");
  expect(slackReady(snapshot("ready"), "research")).toBe(true);
  expect(slackWaitReason(snapshot("ready"), "research")).toBeUndefined();
  // An unreadable record reports nothing instead of failing the caller that shows it.
  store.db.prepare("UPDATE runtime_meta SET value='not json' WHERE key='slack_readiness_v1'").run();
  expect(readSlackReadiness(store)).toBeNull();
  store.db
    .prepare("UPDATE runtime_meta SET value=? WHERE key='slack_readiness_v1'")
    .run(JSON.stringify({ updatedAt: 1, installations: [{ agentId: "research" }] }));
  expect(readSlackReadiness(store)).toBeNull();
});

it("keeps an artifact publication queued while its installation is not ready", async () => {
  const store = new Store(":memory:");
  stores.push(store);
  const config = configSchema.parse(configFixture) as MateConfig,
    messages = new Messages(store, config),
    attention = new CanonicalAttention(messages),
    gate = new CanonicalFreshnessGate(messages, attention),
    artifacts: { current?: CanonicalArtifactTransport } = {},
    output = new Output(
      messages,
      { post: async () => ({ ts: "101.000001" }) },
      Date.now,
      gate,
      () => artifacts.current,
    ),
    collaboration = new Collaboration(store, messages, output, config, attention);
  store.register("research", "v1", []);
  messages.membership("research", "CTEST", true);
  const target = fixtureTarget("CTEST", "100.000001"),
    work = collaboration.createWork("artifact-wait", target);
  collaboration.enqueue("research", work, "one", {});
  const run = store.beginRun("research")!;
  store.input(run, {});
  // The adapter refuses before allocating anything, exactly as the not-ready Slack service does.
  artifacts.current = {
    configured: () => true,
    supports: () => true,
    upload: async () => {
      throw new SlackNotReadyError("installation is waiting to recover");
    },
  };
  output.queueArtifact(
    "research",
    target,
    "caption",
    { title: "file", content: "frozen", contentHash: "hash" },
    "upload",
    { run },
  );
  store.db.prepare("INSERT INTO output_work VALUES(?,?)").run("upload", work);
  const draft = output.gate!.describe("research", "upload") as { holdId: string };
  output.gate!.continueOnce(run, "upload", 1, draft.holdId);
  await output.send("upload");
  // Waiting, never a failed external effect: the frozen publication is still queued.
  const row = store.output("upload")!;
  expect(row.state).toBe("pending");
  expect(JSON.parse(row.receipt!).retryAt).toBeGreaterThanOrEqual(Date.now());
});
