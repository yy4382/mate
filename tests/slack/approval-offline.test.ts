import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../../src/storage/store.js";
import { configSchema } from "../../src/config.js";
import { configFixture } from "../helpers/config.js";
import { Messages, Output, fixtureTarget } from "../helpers/canonical-slack.js";
import { Collaboration } from "../../src/collaboration/service.js";
import { CanonicalAttention } from "../../src/conversations/attention.js";
import { CanonicalFreshnessGate } from "../../src/conversations/freshness.js";
import { Ingress } from "../../src/daemon/ingress.js";
import { Controls } from "../../src/daemon/control.js";
import { SlackService } from "../../src/slack/service.js";
import { SystemOperations } from "../../src/policy/system-operations.js";
import { CanonicalSlackNormalizer } from "../../src/slack/normalize.js";
import { CanonicalSlackTransport } from "../../src/slack/transport.js";
import type { SlackInstallationState } from "../../src/slack/readiness.js";
const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanups.splice(0).forEach((fn) => fn());
});
function setup() {
  const config = configSchema.parse(configFixture),
    store = new Store(":memory:");
  cleanups.push(() => store.close());
  const messages = new Messages(store, config),
    attention = new CanonicalAttention(messages),
    gate = new CanonicalFreshnessGate(messages, attention),
    output = new Output(messages, { post: async () => ({ ts: "101.000001" }) }, Date.now, gate),
    collaboration = new Collaboration(store, messages, output, config, attention),
    transport = new CanonicalSlackTransport(store, messages.mapper, { research: "synthetic" }),
    ingress = new Ingress(
      collaboration,
      new CanonicalSlackNormalizer(messages, messages.mapper, output),
    ),
    execute = vi.fn(async () => ({ code: 0, stdout: "done", stderr: "", truncated: false })),
    system = new SystemOperations(store, collaboration, ["research"], { execute }, () => 1000),
    slack = new SlackService(
      collaboration,
      transport,
      ingress,
      { execute: () => "unused" } as unknown as Controls,
      () => false,
      system,
    ),
    client = transport.clients.get("research")!;
  store.register("research", "v1", []);
  messages.membership("research", "CTEST", true);
  const work = collaboration.createWork("system-approval", fixtureTarget("CTEST", "100.000001"));
  collaboration.enqueue("research", work, "start", {});
  const run = store.beginRun("research")!;
  store.input(run, {});
  const open = vi.fn(async () => ({ ok: true, channel: { id: "DOWNER" } })),
    post = vi.fn(async () => ({ ok: true, ts: "200.000001" }));
  client.conversations.open = open as never;
  client.chat.postMessage = post as never;
  const readiness = (state: SlackInstallationState) => {
    transport.setReadiness({
      updatedAt: 1,
      installations: [
        {
          agentId: "research",
          state,
          reason: state === "ready" ? "connected" : "transport_gap",
          attempts: 1,
          changedAt: 1,
        },
      ],
    });
  };
  return {
    store,
    collaboration,
    system,
    slack,
    transport,
    run,
    work,
    execute,
    open,
    post,
    readiness,
  };
}
const request = (
  context: ReturnType<typeof setup>,
  id: string,
  input = { program: "/usr/bin/id", args: [], cwd: "/tmp" },
) => context.system.request(context.run, context.work, id, input);
const click = (context: ReturnType<typeof setup>, id: string, action: string) => {
  context.store.ingest("AONE", `${action}:${id}`, {
    type: "block_actions",
    api_app_id: "AONE",
    team: { id: "TTEST" },
    user: { id: "UOWNER" },
    actions: [{ action_id: action, value: id }],
  });
  context.slack.replay();
};
it("waits for Slack before asking for approval and never approves through recovery", async () => {
  const context = setup(),
    pending = request(context, "offline-root");
  context.readiness("waiting");
  // While the installation is not ready nothing is asked, nothing is approved, nothing runs.
  await context.slack.flushApprovals();
  expect(context.open).not.toHaveBeenCalled();
  expect(context.post).not.toHaveBeenCalled();
  await context.system.dispatchApproved();
  expect(context.execute).not.toHaveBeenCalled();
  expect(context.system.status("research", pending.id).status).toBe("pending");
  // The prompt stays queued in its durable record, so recovery asks instead of failing the request.
  expect(
    context.store.db.prepare("SELECT notice_state FROM system_requests WHERE id=?").get(pending.id),
  ).toEqual({ notice_state: "pending" });
  // Recovery delivers the prompt that waited; it is still only a request, not an approval.
  context.readiness("ready");
  await context.slack.flushApprovals();
  expect(context.post).toHaveBeenCalledOnce();
  expect(JSON.stringify(context.post.mock.calls)).toContain(pending.id);
  await context.system.dispatchApproved();
  expect(context.execute).not.toHaveBeenCalled();
  expect(context.system.status("research", pending.id).status).toBe("pending");
  // The owner's explicit approval, inside its validity window, is what starts the command.
  click(context, pending.id, "mate_system_approve");
  expect(context.system.status("research", pending.id).status).toBe("approved");
  await context.system.dispatchApproved();
  expect(context.execute).toHaveBeenCalledOnce();
  expect(context.system.status("research", pending.id).status).toBe("succeeded");
});
it("does not start an approved command whose window closed or whose approval never reached the owner", async () => {
  const context = setup(),
    expired = request(context, "expired-root");
  context.readiness("ready");
  await context.slack.flushApprovals();
  click(context, expired.id, "mate_system_approve");
  context.system.expire(1000 + 601001);
  await context.system.dispatchApproved();
  expect(context.execute).not.toHaveBeenCalled();
  expect(context.system.status("research", expired.id).status).toBe("expired");
  // An approval prompt that could not be delivered ends the request instead of leaving it runnable.
  const undelivered = request(context, "no-ui-root");
  context.post.mockImplementationOnce(async () => {
    throw new Error("Slack interface unavailable");
  });
  await context.slack.flushApprovals();
  expect(context.system.status("research", undelivered.id).status).toBe("failed");
  const approved = request(context, "rejected-root");
  click(context, approved.id, "mate_system_reject");
  await context.system.dispatchApproved();
  expect(context.execute).not.toHaveBeenCalled();
  expect(context.system.status("research", approved.id).status).toBe("rejected");
});
