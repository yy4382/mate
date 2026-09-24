import { afterEach, expect, it, vi } from "vitest";
import type { WebClient } from "@slack/web-api";
import { Store } from "../../src/storage/store.js";
import { slackApplication } from "../../src/slack/application.js";
import { Directory } from "../../src/slack/directory.js";
import { TeamDirectory } from "../../src/conversations/team-directory.js";
import { CanonicalOutput } from "../../src/conversations/output.js";
import { Collaboration } from "../../src/collaboration/service.js";
import { Broker } from "../../src/policy/broker.js";
import { ToolRouter } from "../../src/runtime/tools.js";
import { CanonicalSlackNormalizer } from "../../src/slack/normalize.js";
import { CanonicalSlackTransport } from "../../src/slack/transport.js";
import { SlackService } from "../../src/slack/service.js";
import { slackPrincipal } from "../../src/slack/principals.js";
import {
  requiredSlackBotScopes,
  slackAppManifest,
  slackMethods,
} from "../../src/slack/capabilities.js";
import { configFixture } from "../helpers/config.js";
import { confirmRememberedChannels } from "../helpers/slack-maintenance.js";
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));
const signal = new AbortController().signal;
/** One acting Agent with a stubbed Slack installation; the directory is the production adapter. */
function fixture() {
  const s = new Store(":memory:");
  cleanup.push(() => s.close());
  const { messages: m, mapper } = slackApplication(s, configFixture);
  s.register("research", "baseline", []);
  const api = {
    list: vi.fn(async (): Promise<any> => ({ channels: [], response_metadata: {} })),
    info: vi.fn(async (): Promise<any> => ({
      ok: true,
      channel: { id: "CNEW", is_private: false, is_member: false },
    })),
  };
  const transport = new CanonicalSlackTransport(s, mapper, { research: "synthetic" });
  transport.clients.set("research", {
    users: { conversations: api.list },
    conversations: { info: api.info },
  } as unknown as WebClient);
  const d = new Directory(m, transport.clients, mapper),
    directory = new TeamDirectory(m, d);
  const out = new CanonicalOutput(m, {
    post: async () => {
      throw new Error("offline");
    },
    pendingInput: () => false,
    classify: () => ({ kind: "unknown" }),
  });
  const c = new Collaboration(s, m, out, configFixture),
    normalizer = new CanonicalSlackNormalizer(m, mapper, out),
    home = mapper.conversation("CHOME");
  m.membership("research", home, true);
  const w = c.createWork("home", { conversationId: home });
  c.enqueue("research", w, "manual", {});
  const run = s.beginRun("research")!;
  s.input(run, {});
  const router = new ToolRouter(
    c,
    new Broker(
      s,
      c,
      { execute: async () => ({ code: 0, stdout: "", stderr: "", truncated: false }) },
      {},
    ),
    undefined,
    directory,
  );
  return {
    s,
    m,
    mapper,
    api,
    transport,
    out,
    c,
    normalizer,
    d,
    directory,
    run,
    w,
    router,
    call: (operation: string, input: unknown) =>
      router.call(run, w, operation, operation, input, signal),
    service: () => new SlackService(c, transport, {} as any, {} as any),
    event: (eventId: string, event: unknown) => {
      s.ingest("AONE", eventId, { team_id: "TTEST", event });
      normalizer.normalize("AONE", eventId);
    },
  };
}
it("session list reports source, type and per-source catalog coverage", async () => {
  const f = fixture(),
    room = f.m.references.createConversation("channel", "internal").id;
  f.m.membership("research", room, true);
  f.api.list
    .mockResolvedValueOnce({
      channels: [{ id: "CNEW", name: "new-public", purpose: { value: "shared" } }],
      response_metadata: { next_cursor: "page-2" },
    })
    .mockResolvedValueOnce({
      channels: [{ id: "DOPEN", is_im: true, user: "UOWNER" }],
      response_metadata: {},
    });
  const value = (await f.call("conversations.list", {})).value as any;
  expect(value.spaces).toEqual([
    {
      conversationId: f.mapper.conversation("CNEW"),
      source: "external",
      kind: "channel",
      name: "new-public",
      purpose: "shared",
      archived: false,
    },
    {
      conversationId: f.mapper.conversation("DOPEN"),
      source: "external",
      kind: "dm",
      principal: slackPrincipal(configFixture, "UOWNER"),
      archived: false,
    },
    { conversationId: room, source: "internal", kind: "channel", archived: false },
  ]);
  expect(value.coverage).toEqual([
    { source: "external", complete: true },
    { source: "internal", complete: true },
  ]);
  // The listing is also the membership sync for a channel the Agent was invited to while offline.
  expect(f.m.access("research", f.mapper.conversation("CNEW"))).toBe(true);
  expect(f.m.access("research", f.mapper.conversation("DOPEN"))).toBe(true);
});
it("catalog coverage stays honest when the external directory fails and for internal rooms", async () => {
  const f = fixture(),
    room = f.m.references.createConversation("channel", "internal").id;
  f.m.membership("research", room, true);
  f.api.list.mockRejectedValue(new Error("network unavailable"));
  const value = (await f.call("conversations.list", {})).value as any;
  expect(value.spaces).toEqual([
    { conversationId: room, source: "internal", kind: "channel", archived: false },
  ]);
  expect(value.coverage).toEqual([
    {
      source: "external",
      complete: false,
      reason: "External directory unavailable; internal spaces remain available",
    },
    { source: "internal", complete: true },
  ]);
});
it("an invitation or a removal in Slack changes access through membership sync", () => {
  const f = fixture(),
    invited = f.mapper.conversation("CNEW");
  expect(f.m.access("research", invited)).toBe(false);
  f.event("invited", { type: "member_joined_channel", channel: "CNEW", user: "UONE" });
  expect(f.m.access("research", invited)).toBe(true);
  f.event("someone-else", { type: "member_joined_channel", channel: "COTHER", user: "UOWNER" });
  expect(f.m.access("research", f.mapper.conversation("COTHER"))).toBe(false);
  f.event("removed", { type: "member_left_channel", channel: "CNEW", user: "UONE" });
  expect(f.m.access("research", invited)).toBe(false);
});
it("startup and reconnect discovery grant access to a channel the Agent was invited to while offline", async () => {
  const f = fixture();
  f.api.list.mockResolvedValue({
    channels: [{ id: "CNEW", name: "new-public" }],
    response_metadata: {},
  });
  expect(await f.service().discoverMembership(true)).toBe(true);
  expect(f.m.access("research", f.mapper.conversation("CNEW"))).toBe(true);
});
it("a truncated external catalog is reported as incomplete instead of assumed complete", async () => {
  const f = fixture();
  f.api.list.mockResolvedValue({
    channels: [{ id: "CNEW", name: "new-public" }],
    response_metadata: { next_cursor: "page-2" },
  });
  expect(await f.d.spaces("research", 1)).toMatchObject({
    coverage: [
      { source: "external", complete: false, reason: "listing stopped before the last page" },
    ],
  });
});
it("refresh refuses a concurrent membership change instead of writing a stale fact", async () => {
  const f = fixture(),
    id = f.mapper.conversation("CNEW");
  let release!: (value: unknown) => void;
  f.api.info.mockImplementation(() => new Promise((resolve) => (release = resolve)));
  const refreshing = f.directory.refresh("research", id, signal);
  f.m.membership("research", id, false);
  release({ ok: true, channel: { id: "CNEW", is_private: false, is_member: true } });
  await expect(refreshing).rejects.toThrow("changed during refresh");
  expect(f.m.access("research", id)).toBe(false);
});
it("platform revocation closes access at the next membership sync", async () => {
  const f = fixture(),
    id = f.mapper.conversation("CNEW");
  f.m.membership("research", id, true);
  f.api.info.mockResolvedValue({ ok: true, channel: { id: "CNEW", is_member: false } });
  expect(await confirmRememberedChannels(f.service(), "research")).toBe(true);
  expect(f.m.access("research", id)).toBe(false);
});
it("refresh reports the membership the platform currently shows and never joins or leaves", async () => {
  const f = fixture(),
    id = f.mapper.conversation("CNEW");
  f.api.info.mockResolvedValue({
    ok: true,
    channel: { id: "CNEW", is_private: false, is_member: true },
  });
  expect((await f.call("conversations.refresh", { conversationId: id })).value).toMatchObject({
    status: "succeeded",
    conversationId: id,
    active: true,
  });
  expect(f.m.access("research", id)).toBe(true);
  f.api.info.mockResolvedValue({
    ok: true,
    channel: { id: "CNEW", is_private: false, is_member: false },
  });
  expect((await f.call("conversations.refresh", { conversationId: id })).value).toMatchObject({
    status: "succeeded",
    active: false,
  });
  expect(f.m.access("research", id)).toBe(false);
  const dm = f.mapper.conversation("DOPEN");
  expect((await f.call("conversations.refresh", { conversationId: dm })).value).toMatchObject({
    status: "unsupported",
  });
  const room = f.m.references.createConversation("channel", "internal").id;
  f.m.membership("research", room, true);
  expect((await f.call("conversations.refresh", { conversationId: room })).value).toMatchObject({
    status: "unsupported",
  });
  expect(f.api.info).toHaveBeenCalledTimes(2);
});
it("the installed app asks only for the permissions retained operations need", () => {
  const manifest = slackAppManifest("research"),
    scopes = manifest.oauth_config.scopes.bot as string[];
  for (const scope of ["channels:join", "channels:manage", "groups:write"])
    expect(scopes).not.toContain(scope);
  expect(scopes).toContain("channels:read");
  expect(manifest.settings.event_subscriptions.bot_events).toEqual(
    expect.arrayContaining(["member_joined_channel", "member_left_channel"]),
  );
  expect(Object.keys(slackMethods)).not.toContain("conversations.join");
  expect(Object.keys(slackMethods)).not.toContain("conversations.leave");
});
