import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createControlPlane } from "../../src/application.js";

const password = "owner-password-used-only-by-this-test";
const cases: Array<{ app: ReturnType<typeof createControlPlane>; dataDir: string }> = [];

afterEach(() => {
  for (const { app, dataDir } of cases.splice(0)) {
    app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "mate-owner-messages-"));
  chmodSync(dataDir, 0o700);
  const passwordFile = join(dataDir, "owner-password");
  writeFileSync(passwordFile, `${password}\n`, { mode: 0o600 });
  const app = createControlPlane({ dataDir, passwordFile });
  cases.push({ app, dataDir });
  return { app, dataDir, passwordFile };
}

async function ownerCookie(app: ReturnType<typeof createControlPlane>): Promise<string> {
  const login = await app.http.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  expect(login.status).toBe(204);
  return login.headers.get("set-cookie")!.split(";", 1)[0]!;
}

it("persists top-level messages with Mate identity and channel order", async () => {
  const fixture = setup();
  const cookie = await ownerCookie(fixture.app);
  const channelResponse = await fixture.app.http.request("/api/owner/channels", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "日常", description: "", visibility: "public" }),
  });
  const channel = await channelResponse.json();

  expect(channelResponse.status).toBe(201);

  async function send(text: string) {
    const response = await fixture.app.http.request(`/api/owner/channels/${channel.id}/messages`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    expect(response.status).toBe(201);
    return response.json();
  }

  const first = await send("先确认安排"),
    second = await send("下午三点再同步");

  expect(first).toMatchObject({
    channelId: channel.id,
    rootId: null,
    author: { kind: "human", id: "owner" },
    text: "先确认安排",
    order: "1",
  });
  expect(first).not.toHaveProperty("revision");
  expect(first.id).toMatch(/^[0-9a-f-]{36}$/i);
  expect(second).toMatchObject({ text: "下午三点再同步", order: "2" });
  expect(second).not.toHaveProperty("revision");
  expect(second.id).not.toBe(first.id);

  fixture.app.close();
  const restarted = createControlPlane({
    dataDir: fixture.dataDir,
    passwordFile: fixture.passwordFile,
  });
  cases.push({ app: restarted, dataDir: fixture.dataDir });
  const history = await restarted.http.request(`/api/owner/channels/${channel.id}/messages`, {
    headers: { cookie },
  });

  expect(history.status).toBe(200);
  expect(await history.json()).toEqual({ messages: [first, second], nextBefore: null });
});

it("pages back to older top-level messages using the channel order cursor", async () => {
  const { app } = setup();
  const cookie = await ownerCookie(app);
  const channelResponse = await app.http.request("/api/owner/channels", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "历史", description: "", visibility: "public" }),
  });
  const channel = await channelResponse.json();

  for (let index = 1; index <= 51; index++) {
    const response = await app.http.request(`/api/owner/channels/${channel.id}/messages`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: `第 ${index} 条` }),
    });
    expect(response.status).toBe(201);
  }

  const latest = await app.http.request(`/api/owner/channels/${channel.id}/messages`, {
    headers: { cookie },
  });
  const latestPage = await latest.json();
  expect(latestPage.messages).toHaveLength(50);
  expect(latestPage.messages[0]).toMatchObject({ text: "第 2 条", order: "2" });
  expect(latestPage.messages.at(-1)).toMatchObject({ text: "第 51 条", order: "51" });
  expect(latestPage.nextBefore).toBe("2");

  const older = await app.http.request(
    `/api/owner/channels/${channel.id}/messages?before=${latestPage.nextBefore}&limit=50`,
    { headers: { cookie } },
  );
  expect(await older.json()).toMatchObject({
    messages: [expect.objectContaining({ text: "第 1 条", order: "1" })],
    nextBefore: null,
  });
});

it("locates an older message and a thread reply by ID for a notification landing", async () => {
  const { app } = setup();
  const cookie = await ownerCookie(app);
  const created = await app.http.request("/api/owner/channels", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "通知", description: "", visibility: "public" }),
  });
  const { id: channelId } = await created.json();
  const send = async (text: string, extra: Record<string, string> = {}) => {
    const response = await app.http.request(`/api/owner/channels/${channelId}/messages`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text, ...extra }),
    });
    expect(response.status).toBe(201);
    return response.json();
  };
  const root = await send("旧消息");
  const reply = await send("讨论串中的提及", { rootId: root.id });
  for (let index = 0; index < 51; index++) await send(`新消息 ${index}`);

  const older = await app.http.request(
    `/api/owner/channels/${channelId}/messages/${root.id}/context`,
    {
      headers: { cookie },
    },
  );
  expect(older.status).toBe(200);
  expect(await older.json()).toMatchObject({
    kind: "timeline",
    messageId: root.id,
    page: { messages: [expect.objectContaining({ id: root.id })] },
    hasNewer: true,
  });

  const thread = await app.http.request(
    `/api/owner/channels/${channelId}/messages/${reply.id}/context`,
    { headers: { cookie } },
  );
  expect(thread.status).toBe(200);
  expect(await thread.json()).toMatchObject({
    kind: "thread",
    messageId: reply.id,
    thread: { root: { id: root.id }, replies: [expect.objectContaining({ id: reply.id })] },
  });
  expect(
    (
      await app.http.request(`/api/owner/channels/wrong/messages/${reply.id}/context`, {
        headers: { cookie },
      })
    ).status,
  ).toBe(404);
});

it("keeps quote replies on the timeline and thread replies under the root after restart", async () => {
  const fixture = setup();
  const cookie = await ownerCookie(fixture.app);
  const created = await fixture.app.http.request("/api/owner/channels", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "讨论", description: "", visibility: "public" }),
  });
  const { id: channelId } = await created.json();
  async function send(text: string, extra: Record<string, string> = {}) {
    const response = await fixture.app.http.request(`/api/owner/channels/${channelId}/messages`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text, ...extra }),
    });
    expect(response.status).toBe(201);
    return response.json();
  }
  const root = await send("主话题");
  const quote = await send("引用答复", { quoteId: root.id });
  for (let n = 1; n <= 4; n++) await send(`讨论 ${n}`, { rootId: root.id });
  expect(quote).toMatchObject({ rootId: null, quoteId: root.id });
  fixture.app.close();
  const restarted = createControlPlane({
    dataDir: fixture.dataDir,
    passwordFile: fixture.passwordFile,
  });
  cases.push({ app: restarted, dataDir: fixture.dataDir });
  const timeline = await restarted.http.request(`/api/owner/channels/${channelId}/messages`, {
    headers: { cookie },
  });
  const page = await timeline.json();
  expect(page.messages).toHaveLength(2);
  expect(page.messages[0]).toMatchObject({ id: root.id, replyCount: 4 });
  expect(page.messages[0].recentReplies.map((reply: { text: string }) => reply.text)).toEqual([
    "讨论 2",
    "讨论 3",
    "讨论 4",
  ]);
  expect(page.messages[1]).toMatchObject({ id: quote.id, rootId: null, replyCount: 0 });
  const thread = await restarted.http.request(
    `/api/owner/channels/${channelId}/threads/${root.id}`,
    {
      headers: { cookie },
    },
  );
  expect((await thread.json()).replies.map((reply: { text: string }) => reply.text)).toEqual([
    "讨论 1",
    "讨论 2",
    "讨论 3",
    "讨论 4",
  ]);
});
