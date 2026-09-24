import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../../src/storage/store.js";
import { slackApplication } from "../../src/slack/application.js";
import { CanonicalOutput } from "../../src/conversations/output.js";
import { CanonicalSlackTransport } from "../../src/slack/transport.js";
import { CanonicalSlackNormalizer } from "../../src/slack/normalize.js";
import { Collaboration } from "../../src/collaboration/service.js";
import { TeamDirectory } from "../../src/conversations/team-directory.js";
import { Projections } from "../../src/conversations/projections.js";
import { ProjectionImports } from "../../src/conversations/projection-imports.js";
import { SlackProjectionTransport, SlackProjectionInput } from "../../src/slack/projections.js";
import { SlackProjectionService } from "../../src/slack/projection-service.js";
import { configFixture } from "../helpers/config.js";
const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));
async function setup() {
  const config = {
    ...configFixture,
    agents: [
      configFixture.agents[0]!,
      {
        ...configFixture.agents[0]!,
        id: "writer",
        name: "Writer",
        slackUserId: "UTWO",
        slackBotId: "BTWO",
        slackAppId: "ATWO",
        botTokenEnv: "WRITER_BOT",
        appTokenEnv: "WRITER_APP",
      },
    ],
  };
  const s = new Store(":memory:");
  stores.push(s);
  for (const a of config.agents) s.register(a.id, "test", []);
  const { messages, mapper } = slackApplication(s, config),
    transport = new CanonicalSlackTransport(s, mapper, {}),
    post = vi.fn(async (_args: any) => ({ ts: "20.000001", channel: "CDISPLAY" }));
  transport.clients.set("research", {
    conversations: { info: async () => ({ channel: { is_member: true } }) },
    chat: { postMessage: post },
  } as any);
  const output = new CanonicalOutput(messages, transport),
    c = new Collaboration(s, messages, output, config),
    directory = new TeamDirectory(messages);
  s.enqueue("research", "start", {});
  const run = s.beginRun("research")!;
  s.input(run, {});
  const target = (await directory.openDM(
    run,
    "dm",
    { kind: "agent", id: "writer" },
    new AbortController().signal,
  )) as { conversationId: string };
  const core = new Projections(
      messages,
      new Map([["slack", new SlackProjectionTransport(transport)]]),
      () => 0,
    ),
    imports = new ProjectionImports(c, core),
    input = new SlackProjectionInput(core, imports, transport),
    service = new SlackProjectionService(core, imports, input, transport);
  const response = JSON.parse(
    service.control("UOWNER", "projection-add", target.conversationId, [
      JSON.stringify({
        channel: "CDISPLAY",
        publisher: "research",
        importUsers: ["UOWNER"],
        disclose: true,
      }),
    ])!,
  );
  const bindingId = response.bindingId as string,
    normalizer = new CanonicalSlackNormalizer(messages, mapper, output, input);
  const receive = (id: string, event: Record<string, unknown>, app = "AONE") => {
    s.ingest(app, id, {
      team_id: "TTEST",
      event: { type: "message", channel: "CDISPLAY", ...event },
    });
    normalizer.normalize(app, id);
  };
  const send = async (id = "internal") => {
    const work = c.createWork(`activity:${id}`, target);
    c.send("research", work, target, `private ${id}`, id);
    await output.send(id);
    const messageId = JSON.parse(s.output(id)!.receipt!).messageId as string;
    return {
      messageId,
      projection: s.db
        .prepare("SELECT id FROM projection_outbox WHERE message_id=? AND binding_id=?")
        .get(messageId, bindingId) as { id: string },
    };
  };
  return {
    s,
    config,
    messages,
    mapper,
    transport,
    post,
    output,
    c,
    directory,
    run,
    target,
    core,
    imports,
    input,
    service,
    bindingId,
    normalizer,
    receive,
    send,
  };
}
it("keeps one binding's incomplete history from standing for another binding's coverage", async () => {
  const f = await setup();
  // A second channel presents the same internal room, so the publisher has two independent targets.
  const imports = f.core.binding(f.bindingId).imports,
    other = f.core.configure(
      f.target.conversationId,
      { provider: "slack", workspace: "TTEST", externalId: "DOTHER" },
      "research",
      imports,
      true,
    );
  f.transport.clients.get("research")!.conversations.history = vi.fn(async ({ channel }: any) => {
    if (channel === "DOTHER") throw new Error("Slack history unavailable");
    return { ok: true, messages: [], response_metadata: {} };
  }) as never;
  // One binding's failure is its own fact: the other one stays recovered.
  await expect(f.service.catchUpBinding(other)).resolves.toBe(false);
  await expect(f.service.catchUpBinding(f.bindingId)).resolves.toBe(true);
  // The whole-publisher answer still reports the failure, and a repeated attempt is cheap.
  await expect(f.service.catchUp()).resolves.toBe(false);
  await expect(f.service.catchUpBinding(f.bindingId)).resolves.toBe(true);
});
it("authenticates Slack projection echo before HTTP and records external copy drift without changing the original", async () => {
  const f = await setup(),
    sent = await f.send();
  const before = f.s.db.prepare("SELECT count(*) n FROM deliveries").get();
  f.post.mockImplementationOnce(async (args: any) => {
    f.receive("echo", {
      ts: "20.000001",
      text: args.text,
      user: "UONE",
      bot_id: "BONE",
      metadata: args.metadata,
    });
    return { ts: "20.000001", channel: "CDISPLAY" };
  });
  await f.core.send(sent.projection.id);
  expect(f.core.get(sent.projection.id).state).toBe("sent");
  expect(f.s.db.prepare("SELECT count(*) n FROM deliveries").get()).toEqual(before);
  f.receive("copy-edited", {
    subtype: "message_changed",
    message: {
      ts: "20.000001",
      edited: { ts: "22.000001" },
      text: "altered copy",
      user: "UONE",
      bot_id: "BONE",
    },
  });
  expect(f.core.get(sent.projection.id).drift).toBe("external_copy_changed");
  expect(f.messages.message("writer", sent.messageId).text).toBe("private internal");
  f.receive("copy-deleted", {
    subtype: "message_deleted",
    deleted_ts: "20.000001",
    event_ts: "23.000001",
  });
  expect(f.core.get(sent.projection.id).drift).toBe("external_copy_deleted");
});
it("durably defers unknown roots, lets unrelated input advance, then imports one work-bound reply", async () => {
  const f = await setup(),
    sent = await f.send();
  f.receive("early", {
    ts: "21.000001",
    thread_ts: "20.000001",
    user: "UOWNER",
    text: "human reply",
  });
  expect(f.s.db.prepare("SELECT normalized FROM ingress WHERE event_id='early'").get()).toEqual({
    normalized: 1,
  });
  expect(
    f.s.db.prepare("SELECT status FROM projection_imports WHERE external_id='21.000001'").get(),
  ).toEqual({ status: "pending_dependency" });
  f.receive("independent", { ts: "22.000001", user: "UOWNER", text: "unrelated human input" });
  expect(f.messages.read("writer", f.target).map((m) => m.text)).toContain("unrelated human input");
  await f.core.send(sent.projection.id);
  f.imports.replay();
  f.receive(
    "duplicate-other-app",
    { ts: "21.000001", thread_ts: "20.000001", user: "UOWNER", text: "human reply" },
    "ATWO",
  );
  const replies = f.messages.read("writer", { ...f.target, threadId: sent.messageId });
  expect(replies.map((m) => m.text)).toEqual(["private internal", "human reply"]);
  expect(
    f.s.db
      .prepare(
        "SELECT count(*) n FROM deliveries WHERE agent_id='writer' AND json_extract(payload,'$.messageKey')=?",
      )
      .get(replies[1]!.id),
  ).toEqual({ n: 1 });
  expect(
    f.s.db
      .prepare("SELECT count(*) n FROM projection_outbox WHERE message_id=?")
      .get(replies[1]!.id),
  ).toEqual({ n: 0 });
});
it("rechecks import permission during delayed-root replay and never grants membership from Slack", async () => {
  const f = await setup(),
    sent = await f.send();
  f.receive("pending", {
    ts: "21.000001",
    thread_ts: "20.000001",
    user: "UOWNER",
    text: "must remain inaccessible",
  });
  f.receive("outsider", { ts: "22.000001", user: "UOTHER", text: "unauthorized" });
  await f.core.send(sent.projection.id);
  f.core.setEnabled(f.bindingId, false);
  f.imports.replay();
  expect(
    f.s.db.prepare("SELECT status FROM projection_imports WHERE external_id='21.000001'").get(),
  ).toEqual({ status: "rejected" });
  expect(f.messages.read("writer", f.target).map((m) => m.text)).toEqual(["private internal"]);
  f.receive("membership", { type: "member_left_channel", user: "UONE" });
  expect(f.messages.access("research", f.target.conversationId)).toBe(true);
});
it("multi-App edits remain monotonic and imports never reflect back to their source binding", async () => {
  const f = await setup();
  const other = f.core.configure(
    f.target.conversationId,
    { provider: "slack", workspace: "TTEST", externalId: "COTHER" },
    "research",
    [],
    true,
  );
  f.receive("first", { ts: "1.000001", user: "UOWNER", text: "first" });
  f.receive("edit", { ts: "1.000001", edited: { ts: "3.000001" }, user: "UOWNER", text: "edited" });
  f.receive(
    "stale",
    { ts: "1.000001", edited: { ts: "2.000001" }, user: "UOWNER", text: "stale" },
    "ATWO",
  );
  const message = f.messages.read("writer", f.target)[0]!;
  expect(message.text).toBe("edited");
  expect(
    f.s.db
      .prepare("SELECT binding_id,state,reason FROM projection_outbox WHERE message_id=?")
      .all(message.id),
  ).toEqual([{ binding_id: other, state: "failed", reason: "source_changed_before_publication" }]);
  f.receive("delete", { subtype: "message_deleted", deleted_ts: "1.000001", event_ts: "4.000001" });
  expect(f.messages.message("writer", message.id).deleted).toBe(true);
});
it("forged pending metadata is ordinary authorized human input and cannot confirm an unpublished mirror", async () => {
  const f = await setup(),
    sent = await f.send();
  f.receive("forged", {
    ts: "24.000001",
    text: "human text",
    user: "UOWNER",
    metadata: {
      event_type: "mate_projection",
      event_payload: { id: sent.projection.id, request_hash: "forged" },
    },
  });
  expect(f.core.get(sent.projection.id).state).toBe("pending");
  expect(f.messages.read("writer", f.target).map((m) => m.text)).toContain("human text");
});
it("owner status paginates old faults and authorizes disclosure explicitly", async () => {
  const f = await setup();
  expect(() => f.service.control("UOTHER", "projection-enable", f.bindingId, ["false"])).toThrow(
    "Owner only",
  );
  const old = await f.send("old");
  f.post.mockRejectedValueOnce(new Error("uncertain"));
  await f.core.send(old.projection.id);
  for (let n = 0; n < 105; n++) await f.send(`new-${n}`);
  const first = JSON.parse(
    f.service.control("UOWNER", "projections", f.target.conversationId, [])!,
  );
  expect(first.items).toHaveLength(20);
  expect(first.nextCursor).not.toBeNull();
  let page = first,
    found = false;
  while (page.nextCursor) {
    page = JSON.parse(
      f.service.control("UOWNER", "projections", f.target.conversationId, [
        JSON.stringify({ before: page.nextCursor }),
      ])!,
    );
    if (page.items.some((p: any) => p.id === old.projection.id)) found = true;
  }
  expect(found).toBe(true);
  const faults = JSON.parse(
    f.service.control("UOWNER", "projections", f.target.conversationId, [
      JSON.stringify({ problemsOnly: true }),
    ])!,
  );
  expect(faults.items.some((p: any) => p.id === old.projection.id)).toBe(true);
});

it("management pages retain valid JSON and continuation through the actual Slack admin reply queue", async () => {
  const { Controls } = await import("../../src/daemon/control.js"),
    { SlackService } = await import("../../src/slack/service.js");
  const f = await setup();
  for (let n = 0; n < 25; n++) await f.send(`queue-${n}`);
  const controls = new Controls(f.c, {} as any, {} as any, undefined, (...args) =>
    f.service.control(...args),
  );
  const slack = new SlackService(f.c, f.transport, { bindPeerEchoes() {} } as any, controls);
  f.s.ingest("AONE", "owner-command", {
    command: "/team",
    team_id: "TTEST",
    user_id: "UOWNER",
    channel_id: "CTEST",
    text: `projections ${f.target.conversationId}`,
  });
  slack.replay();
  const reply = f.s.db
    .prepare("SELECT text FROM admin_replies WHERE id='AONE:owner-command'")
    .get() as { text: string };
  expect(reply.text.length).toBeLessThanOrEqual(12000);
  const page = JSON.parse(reply.text);
  expect(page.items).toHaveLength(20);
  expect(page.nextCursor).not.toBeNull();
});
it("durably drains projection history beyond the former five-page boundary", async () => {
  const f = await setup(),
    client = f.transport.clients.get("research")!,
    history = vi.fn(async ({ cursor }: any) => {
      const page = cursor ? Number(cursor) : 0,
        messages = Array.from({ length: 100 }, (_, offset) => ({
          ts: `${page * 100 + offset + 1}.000001`,
          user: "UOWNER",
          text: "projection backlog",
        }));
      return {
        ok: true,
        messages,
        response_metadata: { next_cursor: page < 5 ? String(page + 1) : "" },
      };
    });
  client.conversations.history = history as any;
  client.conversations.replies = vi.fn(async () => ({ ok: true, messages: [] })) as any;
  expect(await f.service.catchUp()).toBe(true);
  expect(history).toHaveBeenCalledTimes(6);
  expect(
    f.s.db
      .prepare("SELECT count(*) n FROM ingress WHERE event_id LIKE 'projection-history:%'")
      .get(),
  ).toEqual({ n: 600 });
});
it("revisits an exhausted unknown projection when Slack evidence appears later", async () => {
  const f = await setup(),
    sent = await f.send("delayed-projection");
  f.post.mockRejectedValueOnce(new Error("lost receipt"));
  await f.core.send(sent.projection.id);
  expect(f.core.get(sent.projection.id).state).toBe("unknown");
  const client = f.transport.clients.get("research")!,
    row = f.core.get(sent.projection.id),
    wire = JSON.parse(row.wire!),
    base = Math.floor(f.core.binding(f.bindingId).createdAt / 1000);
  let visible = false;
  const evidence = {
    ts: `${base + 10}.000001`,
    user: "UONE",
    bot_id: "BONE",
    text: wire.text,
    metadata: {
      event_type: "mate_projection",
      event_payload: { id: row.id, request_hash: row.request_hash },
    },
  };
  client.conversations.history = vi.fn(async ({ oldest }: any) => ({
    ok: true,
    messages: [
      { ts: `${base + 20}.000001`, user: "UOWNER", text: "unrelated" },
      ...(visible && Number(oldest) <= base + 10 ? [evidence] : []),
    ],
  })) as any;
  const now = Date.now();
  await f.service.reconcile(now);
  expect(f.core.get(row.id).state).toBe("unknown");
  visible = true;
  await f.service.reconcile(now + 60_000);
  expect(f.core.get(row.id).state).toBe("unknown");
  await f.service.reconcile(now + 15 * 60_000);
  expect(f.core.get(row.id).state).toBe("sent");
});
it("reconciles an unknown projection beyond five Slack pages", async () => {
  const f = await setup(),
    sent = await f.send("deep-projection");
  f.post.mockRejectedValueOnce(new Error("lost receipt"));
  await f.core.send(sent.projection.id);
  const client = f.transport.clients.get("research")!,
    row = f.core.get(sent.projection.id),
    wire = JSON.parse(row.wire!);
  const history = vi.fn(async ({ cursor }: any) => {
    const page = cursor ? Number(cursor) : 0;
    return {
      ok: true,
      messages:
        page === 6
          ? [
              {
                ts: "30.000001",
                user: "UONE",
                bot_id: "BONE",
                text: wire.text,
                metadata: {
                  event_type: "mate_projection",
                  event_payload: { id: row.id, request_hash: row.request_hash },
                },
              },
            ]
          : [],
      response_metadata: { next_cursor: page < 6 ? String(page + 1) : "" },
    };
  });
  client.conversations.history = history as any;
  for (let round = 0; round < 4 && f.core.get(row.id).state === "unknown"; round++)
    await f.service.reconcile();
  expect(f.core.get(row.id).state).toBe("sent");
  expect(history).toHaveBeenCalledTimes(7);
});
