import { afterEach, expect, it, vi } from "vitest";
import type { WebClient } from "@slack/web-api";
import { Store } from "../../src/storage/store.js";
import { configSchema } from "../../src/config.js";
import { slackApplication } from "../../src/slack/application.js";
import { Directory } from "../../src/slack/directory.js";
import { TeamDirectory } from "../../src/conversations/team-directory.js";
import { CanonicalOutput } from "../../src/conversations/output.js";
import { Collaboration } from "../../src/collaboration/service.js";
import { Broker } from "../../src/policy/broker.js";
import { ToolRouter } from "../../src/runtime/tools.js";
import { CanonicalSlackNormalizer } from "../../src/slack/normalize.js";
import { CanonicalSlackTransport } from "../../src/slack/transport.js";
import { slackAppManifest, slackMethods } from "../../src/slack/capabilities.js";
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));
const signal = new AbortController().signal;
const config = configSchema.parse({
  teamId: "TTEST",
  ownerUserIds: ["UOWNER"],
  runTimeoutMs: 120000,
  agents: [
    {
      id: "research",
      name: "Research",
      role: "Find evidence",
      slackAppId: "AONE",
      slackUserId: "UONE",
      slackBotId: "BONE",
      botTokenEnv: "RESEARCH_BOT_TOKEN",
      appTokenEnv: "RESEARCH_APP_TOKEN",
      model: { provider: "anthropic", id: "configured-model", apiKeyEnv: "MODEL_API_KEY" },
      channels: { CTEST: "mentions" as const },
    },
    {
      id: "writer",
      name: "Writer",
      role: "Write it up",
      slackAppId: "ATWO",
      slackUserId: "UTWO",
      slackBotId: "BTWO",
      botTokenEnv: "WRITER_BOT_TOKEN",
      appTokenEnv: "WRITER_APP_TOKEN",
      model: { provider: "anthropic", id: "configured-model", apiKeyEnv: "MODEL_API_KEY" },
      channels: {},
    },
  ],
});
/** A transport timeout as the HTTP client raises it: no answer, and the effect may have landed. */
const timeoutError = () =>
  Object.assign(new Error("timeout of 15000ms exceeded"), { code: "ECONNABORTED" });
/** A platform refusal as the SDK raises it. */
const platformError = (error: string) =>
  Object.assign(new Error(`An API error occurred: ${error}`), {
    code: "slack_webapi_platform_error",
    data: { ok: false, error },
  });
/**
 * Two installed Agents with stubbed Slack clients. The directories, the tool router and the
 * normalizer are the production adapters; only the platform transport is controllable.
 */
function fixture() {
  const s = new Store(":memory:");
  cleanup.push(() => s.close());
  const { messages: m, mapper } = slackApplication(s, config);
  s.register("research", "baseline", []);
  s.register("writer", "baseline", []);
  const api = {
    invite: vi.fn(async (): Promise<any> => ({ ok: true, channel: { id: "CNEW" } })),
    members: vi.fn(async (): Promise<any> => ({
      ok: true,
      members: ["UONE", "UTWO"],
      response_metadata: {},
    })),
    info: vi.fn(async (): Promise<any> => ({
      ok: true,
      channel: { id: "CNEW", is_member: true },
    })),
    list: vi.fn(async (): Promise<any> => ({ channels: [], response_metadata: {} })),
  };
  const client = (): WebClient =>
    ({
      conversations: { invite: api.invite, members: api.members, info: api.info },
      users: { conversations: api.list },
    }) as unknown as WebClient;
  const transport = new CanonicalSlackTransport(s, mapper, {
    research: "synthetic",
    writer: "synthetic",
  });
  transport.clients.set("research", client());
  transport.clients.set("writer", client());
  const directory = new TeamDirectory(m, new Directory(m, transport.clients, mapper));
  const out = new CanonicalOutput(m, {
    post: async () => {
      throw new Error("offline");
    },
    pendingInput: () => false,
    classify: () => ({ kind: "unknown" }),
  });
  const c = new Collaboration(s, m, out, config),
    normalizer = new CanonicalSlackNormalizer(m, mapper, out),
    home = mapper.conversation("CHOME");
  m.membership("research", home, true);
  const work = c.createWork("home", { conversationId: home }),
    run = (agent: string, key: string) => {
      c.enqueue(agent, work, key, {});
      const token = s.beginRun(agent)!;
      s.input(token, {});
      return token;
    },
    router = new ToolRouter(
      c,
      new Broker(
        s,
        c,
        { execute: async () => ({ code: 0, stdout: "", stderr: "", truncated: false }) },
        {},
      ),
      undefined,
      directory,
    ),
    runToken = run("research", "manual");
  let calls = 0;
  return {
    s,
    m,
    mapper,
    api,
    c,
    normalizer,
    directory,
    runToken,
    work,
    router,
    /** One tool call per distinct call id, so each one owns its own durable record. */
    call: (operation: string, input: unknown) =>
      router.call(runToken, work, `call-${++calls}`, operation, input, signal),
    callAs: (token: ReturnType<typeof run>, operation: string, input: unknown, id: string) =>
      router.call(token, work, id, operation, input, signal),
    run: (agent: string, key: string) => run(agent, key),
    action: (id: string) => s.action(`${runToken.sessionId}:${id}`),
    event: (appId: string, eventId: string, event: unknown) => {
      s.ingest(appId, eventId, { team_id: "TTEST", event });
      normalizer.normalize(appId, eventId);
    },
  };
}
it("a human invitation still reaches the invited Agent through its own membership sync", () => {
  const f = fixture(),
    invited = f.mapper.conversation("CNEW");
  expect(f.m.access("writer", invited)).toBe(false);
  f.event("ATWO", "human-invite", {
    type: "member_joined_channel",
    channel: "CNEW",
    user: "UTWO",
  });
  expect(f.m.access("writer", invited)).toBe(true);
  f.event("ATWO", "human-removal", {
    type: "member_left_channel",
    channel: "CNEW",
    user: "UTWO",
  });
  expect(f.m.access("writer", invited)).toBe(false);
});
it("a member Agent invites one configured teammate, and access follows the confirmed member list", async () => {
  const f = fixture(),
    invited = f.mapper.conversation("CNEW");
  f.m.membership("research", invited, true);
  const result = (
    await f.call("conversations.invite", { conversationId: invited, agentId: "writer" })
  ).value;
  expect(result).toEqual({
    status: "succeeded",
    conversationId: invited,
    agentId: "writer",
    verification: "membership_query",
  });
  expect(f.api.invite).toHaveBeenCalledWith({ channel: "CNEW", users: "UTWO" });
  expect(f.m.access("writer", invited)).toBe(true);
  expect(f.action("call-1")).toMatchObject({ state: "succeeded" });
  expect(JSON.parse(f.action("call-1")!.request)).toMatchObject({
    operation: "conversations.invite",
    conversationId: invited,
    agentId: "writer",
  });
  expect(JSON.parse(f.action("call-1")!.receipt!)).toMatchObject({ status: "succeeded" });
});
it("replays one recorded invitation result instead of asking Slack again", async () => {
  const f = fixture(),
    invited = f.mapper.conversation("CNEW");
  f.m.membership("research", invited, true);
  const input = { conversationId: invited, agentId: "writer" },
    first = await f.callAs(f.runToken, "conversations.invite", input, "same-call"),
    second = await f.callAs(f.runToken, "conversations.invite", input, "same-call");
  expect(first.value).toEqual(second.value);
  expect(first.value).toMatchObject({ status: "succeeded" });
  expect(f.api.invite).toHaveBeenCalledTimes(1);
  expect(f.api.members).toHaveBeenCalledTimes(1);
});
it("only invites into an external channel, never into a direct conversation", async () => {
  const f = fixture(),
    dm = f.mapper.conversation("DOPEN");
  f.m.membership("research", dm, true);
  await expect(
    f.call("conversations.invite", { conversationId: dm, agentId: "writer" }),
  ).rejects.toThrow("Only an external channel carries platform invitations");
  expect(f.api.invite).not.toHaveBeenCalled();
});
it("keeps a request that Slack accepted but did not confirm as an unknown result", async () => {
  const f = fixture(),
    invited = f.mapper.conversation("CNEW");
  f.m.membership("research", invited, true);
  f.api.members.mockResolvedValue({ ok: true, members: ["UONE"], response_metadata: {} });
  expect(
    (await f.call("conversations.invite", { conversationId: invited, agentId: "writer" })).value,
  ).toMatchObject({ status: "unknown", reason: "invitation_accepted_membership_unconfirmed" });
  // Nothing but the platform's member list grants the invited Agent access.
  expect(f.m.access("writer", invited)).toBe(false);
  expect(f.action("call-1")).toMatchObject({ state: "unknown" });
});
it("refuses a non-member inviter, a self-invite and a target that is not a configured teammate", async () => {
  const f = fixture(),
    invited = f.mapper.conversation("CNEW");
  await expect(
    f.call("conversations.invite", { conversationId: invited, agentId: "writer" }),
  ).rejects.toThrow("Conversation access denied");
  f.m.membership("research", invited, true);
  await expect(
    f.call("conversations.invite", { conversationId: invited, agentId: "research" }),
  ).rejects.toThrow("cannot invite itself");
  await expect(
    f.call("conversations.invite", { conversationId: invited, agentId: "ghost" }),
  ).rejects.toThrow("Unknown Agent");
  expect(f.api.invite).not.toHaveBeenCalled();
  expect(f.m.access("writer", invited)).toBe(false);
});
it("reports a target that Slack says is already in the channel from the member list", async () => {
  const f = fixture(),
    invited = f.mapper.conversation("CNEW");
  f.m.membership("research", invited, true);
  f.api.invite.mockRejectedValue(platformError("already_in_channel"));
  expect(
    (await f.call("conversations.invite", { conversationId: invited, agentId: "writer" })).value,
  ).toEqual({
    status: "succeeded",
    conversationId: invited,
    agentId: "writer",
    verification: "membership_query",
    reason: "already_in_channel",
  });
  expect(f.m.access("writer", invited)).toBe(true);
});
it("keeps the platform's own refusal of a private channel invitation definite", async () => {
  const f = fixture(),
    invited = f.mapper.conversation("CPRIV");
  f.m.membership("research", invited, true);
  f.api.invite.mockRejectedValue(platformError("missing_scope"));
  expect(
    (await f.call("conversations.invite", { conversationId: invited, agentId: "writer" })).value,
  ).toMatchObject({ status: "failed", reason: "missing_scope" });
  expect(f.m.access("writer", invited)).toBe(false);
  expect(f.action("call-1")).toMatchObject({ state: "failed" });
});
it("keeps a contradictory member list from confirming an invitation", async () => {
  const f = fixture(),
    invited = f.mapper.conversation("CNEW");
  f.m.membership("research", invited, true);
  f.api.invite.mockRejectedValue(platformError("already_in_channel"));
  f.api.members.mockResolvedValue({ ok: true, members: ["UONE"], response_metadata: {} });
  expect(
    (await f.call("conversations.invite", { conversationId: invited, agentId: "writer" })).value,
  ).toMatchObject({ status: "unknown", reason: "membership_evidence_conflict" });
  expect(f.m.access("writer", invited)).toBe(false);
});
it("never treats an incomplete member listing as proof an uncertain invitation did not land", async () => {
  const f = fixture(),
    invited = f.mapper.conversation("CNEW");
  f.m.membership("research", invited, true);
  f.api.invite.mockRejectedValue(timeoutError());
  await f.call("conversations.invite", { conversationId: invited, agentId: "writer" });
  // The listing stops at its page cap without ever naming the target: that is not absence.
  let page = 0;
  f.api.members.mockImplementation(async () => ({
    ok: true,
    members: ["UONE"],
    response_metadata: { next_cursor: `page-${++page}` },
  }));
  expect(
    (await f.call("conversations.invite", { conversationId: invited, agentId: "writer" })).value,
  ).toMatchObject({ status: "unknown", reason: "invitation_outcome_unverified" });
  expect(f.api.invite).toHaveBeenCalledTimes(1);
  expect(f.action("call-1")).toMatchObject({ state: "unknown" });
  expect(f.m.access("writer", invited)).toBe(false);
});
it("keeps a timed-out invitation unknown, grants nothing, and never resends it blindly", async () => {
  const f = fixture(),
    invited = f.mapper.conversation("CNEW");
  f.m.membership("research", invited, true);
  f.api.invite.mockRejectedValue(timeoutError());
  expect(
    (await f.call("conversations.invite", { conversationId: invited, agentId: "writer" })).value,
  ).toMatchObject({ status: "unknown", reason: "invitation_outcome_unknown" });
  expect(f.m.access("writer", invited)).toBe(false);
  expect(f.action("call-1")).toMatchObject({ state: "unknown" });
  expect(f.api.invite).toHaveBeenCalledTimes(1);
  // A second request verifies the earlier attempt through the member list and sends nothing.
  f.api.members.mockResolvedValue({ ok: true, members: ["UONE"], response_metadata: {} });
  expect(
    (await f.call("conversations.invite", { conversationId: invited, agentId: "writer" })).value,
  ).toMatchObject({
    status: "failed",
    reason: "not_sent_earlier_attempt_absent",
    verification: "membership_query",
  });
  expect(f.api.invite).toHaveBeenCalledTimes(1);
  expect(f.m.access("writer", invited)).toBe(false);
  // The verified non-effect is durable: the earlier attempt is no longer an open unknown.
  expect(f.action("call-1")).toMatchObject({ state: "failed" });
  expect(f.action("call-2")).toMatchObject({ state: "failed" });
});
it("recovers a fenced invitation attempt from the member list when the run resumes", async () => {
  const f = fixture(),
    invited = f.mapper.conversation("CNEW");
  f.m.membership("research", invited, true);
  f.api.invite.mockImplementation(async () => {
    // The operator stops the run while Slack is still answering the invitation request.
    f.s.pause("research");
    return { ok: true, channel: { id: "CNEW" } };
  });
  await expect(
    f.call("conversations.invite", { conversationId: invited, agentId: "writer" }),
  ).rejects.toThrow("Stale or stopped run");
  expect(f.action("call-1")).toMatchObject({ state: "unknown" });
  expect(f.m.access("writer", invited)).toBe(false);
  f.s.resume("research");
  f.api.members.mockResolvedValue({ ok: true, members: ["UONE", "UTWO"], response_metadata: {} });
  const resumed = await f.callAs(
    f.run("research", "resume"),
    "conversations.invite",
    { conversationId: invited, agentId: "writer" },
    "call-1",
  );
  expect(resumed.value).toMatchObject({ status: "succeeded", verification: "membership_query" });
  expect(f.api.invite).toHaveBeenCalledTimes(1);
  expect(f.m.access("writer", invited)).toBe(true);
});
it("never leaves an executing action behind when recording a confirmed invitation fails", async () => {
  const f = fixture(),
    invited = f.mapper.conversation("CNEW");
  f.m.membership("research", invited, true);
  // The platform confirms the member, but the local access write cannot be persisted.
  f.s.db.exec(
    "CREATE TRIGGER reject_writer_access BEFORE INSERT ON channel_access WHEN NEW.agent_id='writer' BEGIN SELECT RAISE(ABORT,'access write rejected'); END",
  );
  await expect(
    f.call("conversations.invite", { conversationId: invited, agentId: "writer" }),
  ).rejects.toThrow("access write rejected");
  expect(f.action("call-1")).toMatchObject({ state: "unknown" });
  expect(f.m.access("writer", invited)).toBe(false);
  // The run still completes: no action was left executing by the failed record.
  f.s.finish(f.runToken);
  expect(f.s.db.prepare("SELECT state FROM runs WHERE id=?").get(f.runToken.id)).toEqual({
    state: "complete",
  });
});
it("recovers a missed join event from the member list without inviting a second time", async () => {
  const f = fixture(),
    invited = f.mapper.conversation("CNEW");
  f.m.membership("research", invited, true);
  f.api.invite.mockRejectedValue(timeoutError());
  await f.call("conversations.invite", { conversationId: invited, agentId: "writer" });
  expect(f.m.access("writer", invited)).toBe(false);
  // The invitation landed after the timeout and the platform event was missed by every socket.
  f.api.members.mockResolvedValue({ ok: true, members: ["UONE", "UTWO"], response_metadata: {} });
  expect(
    (await f.call("conversations.invite", { conversationId: invited, agentId: "writer" })).value,
  ).toMatchObject({ status: "succeeded", verification: "membership_query" });
  expect(f.api.invite).toHaveBeenCalledTimes(1);
  expect(f.m.access("writer", invited)).toBe(true);
  // The recovered fact also settles the earlier uncertain record instead of leaving it open.
  expect(f.action("call-1")).toMatchObject({ state: "succeeded" });
});
it("keeps an unreadable member list from turning an uncertain invitation into a definite result", async () => {
  const f = fixture(),
    invited = f.mapper.conversation("CNEW");
  f.m.membership("research", invited, true);
  f.api.invite.mockRejectedValue(timeoutError());
  await f.call("conversations.invite", { conversationId: invited, agentId: "writer" });
  f.api.members.mockRejectedValue(platformError("ratelimited"));
  expect(
    (await f.call("conversations.invite", { conversationId: invited, agentId: "writer" })).value,
  ).toMatchObject({ status: "unknown", reason: "invitation_outcome_unverified" });
  expect(f.api.invite).toHaveBeenCalledTimes(1);
  expect(f.m.access("writer", invited)).toBe(false);
  // The unverifiable outcome is still a durable result, not a request with no record.
  expect(f.action("call-2")).toMatchObject({ state: "unknown" });
  expect(JSON.parse(f.action("call-2")!.receipt!)).toMatchObject({ status: "unknown" });
});
it("does not invite an Agent into an internal room the host manages", async () => {
  const f = fixture(),
    room = f.m.references.createConversation("channel", "internal").id;
  f.m.membership("research", room, true);
  await expect(
    f.call("conversations.invite", { conversationId: room, agentId: "writer" }),
  ).rejects.toThrow("host-managed");
  expect(f.api.invite).not.toHaveBeenCalled();
});
it("keeps the invitation under the existing independent-review restriction", async () => {
  const f = fixture(),
    invited = f.mapper.conversation("CHOME");
  f.m.membership("writer", invited, true);
  f.c.seats.activate(
    "UOWNER",
    "writer",
    { conversationId: invited },
    "independent brief",
    () => "/w",
  );
  const token = f.run("writer", "seat"),
    listed = (await f.callAs(token, "tools.list", {}, "seat-list")).value as { name: string }[];
  expect(listed.map((entry) => entry.name)).not.toContain("conversations.invite");
  await expect(
    f.callAs(
      token,
      "conversations.invite",
      { conversationId: invited, agentId: "research" },
      "seat",
    ),
  ).rejects.toThrow("Independent review seat isolates this input path");
  expect(f.api.invite).not.toHaveBeenCalled();
});
it("installs only the retained operation scopes plus the two invitation scopes", () => {
  const manifest = slackAppManifest("research"),
    scopes = manifest.oauth_config.scopes.bot as string[];
  expect(slackMethods["conversations.invite"]).toEqual([
    "channels:write.invites",
    "groups:write.invites",
  ]);
  // The complete invited permission set is stated here, so an over-broad install cannot pass by
  // agreeing with the same table it is generated from.
  expect(scopes).toEqual([
    "app_mentions:read",
    "channels:history",
    "channels:read",
    "channels:write.invites",
    "chat:write",
    "commands",
    "files:read",
    "files:write",
    "groups:history",
    "groups:read",
    "groups:write.invites",
    "im:history",
    "im:read",
    "im:write",
    "mpim:history",
    "mpim:read",
    "mpim:write",
    "users:read",
  ]);
  for (const scope of ["channels:join", "channels:manage", "groups:write"])
    expect(scopes).not.toContain(scope);
  expect(Object.keys(slackMethods)).not.toContain("conversations.join");
  expect(Object.keys(slackMethods)).not.toContain("conversations.leave");
});
