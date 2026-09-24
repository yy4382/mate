import { afterEach, expect, it, vi } from "vitest";
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

const target = (
  conversationId: string,
  permission: "confirmed" | "unconfirmed" | "denied",
  history: "pending" | "complete",
  reason: string,
) => ({
  agentId: "research",
  channel: conversationId,
  conversationId,
  permission,
  history,
  reason,
  changedAt: 3,
});
const ready = (targets: ReturnType<typeof target>[]): SlackReadiness => ({
  updatedAt: 7,
  installations: [
    { agentId: "research", state: "ready", reason: "connected", attempts: 1, changedAt: 3 },
  ],
  targets,
});
it("waits for one target's own conditions without holding its installation's other targets", async () => {
  const store = new Store(":memory:");
  stores.push(store);
  // The shared fixture binds the two platform conversations this test acts on.
  const messages = new Messages(store, configSchema.parse(configFixture) as MateConfig),
    transport = new CanonicalSlackTransport(store, messages.mapper, { research: "synthetic" });
  const post = vi.fn(async () => ({ ts: "101.000001" }));
  transport.clients.get("research")!.chat.postMessage = post as never;
  const dispatch = (conversationId: string) =>
    transport.post({
      id: "outbox-1",
      actor: "research",
      target: fixtureTarget(conversationId, "100.000001"),
      text: "body",
      requestHash: "hash",
      originalRequest: "{}",
    });
  // The installation's own connection is ready, so nothing waits for the installation itself.
  transport.setReadiness(
    ready([
      target("CTEST", "unconfirmed", "pending", "membership_unconfirmed"),
      target("CTWO", "confirmed", "complete", "connected"),
    ]),
  );
  expect(transport.waitingFor("research")).toBeUndefined();
  expect(transport.readyFor("research")).toBe(true);
  expect(transport.waitingForTarget("research", "CTEST", "permission")).toBeInstanceOf(
    SlackNotReadyError,
  );
  expect(transport.waitingForTarget("research", "CTEST", "permission")!.reason).toContain(
    "no confirmed permission",
  );
  // A pending permission is not bypassed by dispatch: nothing reaches the platform.
  await expect(dispatch("CTEST")).rejects.toThrow("Slack is not ready");
  expect(post).not.toHaveBeenCalled();
  // The already verified target of the same installation crosses normally.
  await expect(dispatch("CTWO")).resolves.toMatchObject({ receipt: { ts: "101.000001" } });
  expect(post).toHaveBeenCalledOnce();
  // Confirmed permission with history still catching up only holds the local history views.
  transport.setReadiness(ready([target("CTEST", "confirmed", "pending", "history_incomplete")]));
  expect(transport.waitingForTarget("research", "CTEST", "permission")).toBeUndefined();
  expect(transport.waitingForTarget("research", "CTEST", "history")!.reason).toContain(
    "still catching up on history",
  );
  await expect(dispatch("CTEST")).resolves.toMatchObject({ receipt: { ts: "101.000001" } });
  expect(post).toHaveBeenCalledTimes(2);
  // A target this readiness never reported has no pending condition; only the installation applies.
  expect(transport.waitingForTarget("research", "CTHIRD", "permission")).toBeUndefined();
  // A platform denial is a definite answer for the access check, not a wait.
  transport.setReadiness(ready([target("CTEST", "denied", "pending", "not_a_member")]));
  expect(transport.waitingForTarget("research", "CTEST", "permission")).toBeUndefined();
  expect(transport.waitingForTarget("research", "CTEST", "history")).toBeUndefined();
});
it("never holds an internal conversation on a Slack installation's state", () => {
  const store = new Store(":memory:");
  stores.push(store);
  const messages = new Messages(store, configSchema.parse(configFixture) as MateConfig),
    transport = new CanonicalSlackTransport(store, messages.mapper, { research: "synthetic" }),
    internal = { conversationId: "local-room" };
  // The installation cannot even connect, and one of its external targets has no answer either.
  transport.setReadiness({
    updatedAt: 7,
    installations: [
      {
        agentId: "research",
        state: "needs-human",
        reason: "invalid_auth",
        attempts: 2,
        changedAt: 3,
      },
    ],
    targets: [
      {
        agentId: "research",
        channel: "CTEST",
        conversationId: "CTEST",
        permission: "unconfirmed",
        history: "pending",
        reason: "check",
        changedAt: 3,
      },
    ],
  });
  expect(transport.waitingForTarget("research", "CTEST", "permission")).toBeInstanceOf(
    SlackNotReadyError,
  );
  expect(transport.pendingPermission("research", { conversationId: "CTEST" })).toBe(true);
  // A local room is not a Slack target: neither the installation nor a target fact holds it.
  expect(transport.pendingPermission("research", internal)).toBe(false);
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

it("does not let a waiting installation's backlog hide another installation's publications", () => {
  const store = new Store(":memory:");
  stores.push(store);
  const config = configSchema.parse({
      ...configFixture,
      agents: [
        configFixture.agents[0],
        {
          ...configFixture.agents[0],
          id: "writer",
          name: "Writer",
          slackAppId: "ATWO",
          slackUserId: "UTWO",
          slackBotId: "BTWO",
          botTokenEnv: "WRITER_BOT",
          appTokenEnv: "WRITER_APP",
        },
      ],
    }) as MateConfig,
    messages = new Messages(store, config),
    attention = new CanonicalAttention(messages),
    // No gate: these rows are dispatchable publications, not drafts awaiting a decision.
    output = new Output(messages, { post: async () => ({ ts: "101.000001" }) }),
    transport = new CanonicalSlackTransport(store, messages.mapper, {
      research: "synthetic",
      writer: "synthetic",
    }),
    collaboration = new Collaboration(store, messages, output, config, attention),
    target = fixtureTarget("CTEST", "100.000001");
  for (const agentId of ["research", "writer"]) {
    store.register(agentId, "v1", []);
    messages.membership(agentId, "CTEST", true);
  }
  transport.setReadiness({
    updatedAt: 1,
    installations: [
      { agentId: "research", state: "ready", reason: "connected", attempts: 0, changedAt: 1 },
      {
        agentId: "writer",
        state: "waiting",
        reason: "transport_gap",
        attempts: 1,
        changedAt: 1,
      },
    ],
  });
  const work = collaboration.createWork("backlog", target);
  for (let index = 0; index < 25; index++)
    collaboration.send("writer", work, target, `blocked ${index}`, `blocked-${index}`);
  collaboration.send("research", work, target, "ready body", "ready-one");
  // The ready installation is served even though the waiting one owns the queue head.
  expect(output.ready(20, "external", transport.readyAgents())).toEqual([{ id: "ready-one" }]);
});
