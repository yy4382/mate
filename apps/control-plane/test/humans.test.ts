import { describe, expect, it } from "vitest";
import { environment, PASSWORD, type Browser, type Site } from "./support.ts";

type Human = {
  accountId: number;
  handle: string;
  displayName: string;
  role: "admin" | "member";
  active: boolean;
};
type History = { author: number; body?: string }[];

const MEMBER_PASSWORD = "sam has a long password";

const refusal = (answer: { status: number; json: unknown }) => [
  answer.status,
  (answer.json as { error?: string } | undefined)?.error,
];

async function adminSite() {
  const env = environment();
  const site = await env.start();
  const admin = site.browser();
  await admin.logInAdmin();
  return { env, site, admin };
}

let requests = 0;
async function addHuman(
  admin: Browser,
  who: { handle: string; displayName?: string; role?: "admin" | "member"; password?: string },
): Promise<Human> {
  const added = await admin.post("/api/humans", {
    requestId: `add-${++requests}`,
    displayName: who.displayName ?? who.handle,
    handle: who.handle,
    password: who.password ?? MEMBER_PASSWORD,
    role: who.role ?? "member",
  });
  expect(added.status, added.text).toBe(200);
  return added.json as Human;
}

async function memberOf(site: Site, admin: Browser) {
  const human = await addHuman(admin, { handle: "sam", displayName: "Sam" });
  const member = site.browser();
  expect((await member.logIn("sam", MEMBER_PASSWORD)).status).toBe(200);
  return { human, member };
}

async function channel(browser: Browser, name: string, visibility = "public"): Promise<number> {
  const made = await browser.post("/api/chat/channels", {
    requestId: `c-${name}`,
    name,
    visibility,
  });
  expect(made.status, made.text).toBe(200);
  return (made.json as { conversationId: number }).conversationId;
}

let posts = 0;
const say = (browser: Browser, conversation: number, body: string) =>
  browser.post("/api/chat/messages", {
    timeline: { conversation },
    requestId: `say-${++posts}`,
    body,
  });

describe("11.2 humans: the first admin", () => {
  it("creates an admin named by the initial handle on the first start, who logs in with the handle and the initial password", async () => {
    const env = environment();
    const site = await env.start({ initialHandle: "Boss" });
    const boss = site.browser();

    expect((await boss.logIn("boss", PASSWORD)).status, "handles ignore case").toBe(200);
    expect((await boss.get("/api/me")).json).toMatchObject({
      handle: "Boss",
      displayName: "Boss",
      role: "admin",
    });
    expect((await site.browser().logIn("admin", PASSWORD)).status, "not the default").toBe(401);
  });

  it("calls the first admin admin when no initial handle is given, and does not create another human on a restart", async () => {
    const env = environment();
    const first = await env.start();
    expect((await first.browser().logIn("admin", PASSWORD)).status).toBe(200);
    await first.close();

    const second = await env.start({ initialHandle: "someone-else" });
    const admin = second.browser();
    expect((await admin.logIn("admin", PASSWORD)).status).toBe(200);
    expect((await second.browser().logIn("someone-else", PASSWORD)).status).toBe(401);
    expect(((await admin.get("/api/humans")).json as Human[]).map((human) => human.handle)).toEqual(
      ["admin"],
    );
  });

  it("refuses to start for the first time with an initial handle that is not a handle", async () => {
    const env = environment();
    await expect(env.start({ initialHandle: "not a handle!" })).rejects.toThrow(/handle/);
    expect(
      (await (await env.start()).browser().logIn("admin", PASSWORD)).status,
      "a later start with a good one works",
    ).toBe(200);
  });
});

describe("11.2 humans: logging in", () => {
  it("refuses a wrong password, an unknown handle, an Agent's handle and a deactivated human's handle in exactly the same way", async () => {
    const { site, admin } = await adminSite();
    await admin.request("PUT", "/api/admin/providers/openai/credentials", {
      apiKey: "sk-test-0001",
    });
    const nodeId = await site.pairNode(admin);
    const agent = await admin.post("/api/admin/agents", {
      nodeId,
      displayName: "Ada",
      handle: "ada",
      settings: { model: { provider: "openai", modelId: "gpt-4.1" } },
    });
    expect(agent.status, agent.text).toBe(200);
    const gone = await addHuman(admin, { handle: "gone" });
    await admin.post(`/api/humans/${gone.accountId}/deactivate`);

    const answers = [
      await site.browser().logIn("admin", "not the password"),
      await site.browser().logIn("nobody", PASSWORD),
      await site.browser().logIn("ada", PASSWORD),
      await site.browser().logIn("gone", MEMBER_PASSWORD),
    ];

    for (const answer of answers) {
      expect(answer.status, answer.text).toBe(401);
      expect(answer.text).toBe(answers[0]?.text);
      expect(answer.headers.get("set-cookie")).toBeNull();
    }
  });

  it("keeps each human's session and password apart", async () => {
    const { site, admin } = await adminSite();
    const { member } = await memberOf(site, admin);

    expect((await site.browser().logIn("sam", PASSWORD)).status, "the admin's password").toBe(401);
    expect((await site.browser().logIn("admin", MEMBER_PASSWORD)).status).toBe(401);
    expect((await admin.get("/api/me")).json).toMatchObject({ handle: "admin" });
    expect((await member.get("/api/me")).json).toMatchObject({ handle: "sam", role: "member" });
  });
});

describe("11.2 humans: members", () => {
  it("lets an admin add a member, once per request ID, who reads every conversation and is turned away from admin and human management", async () => {
    const { site, admin } = await adminSite();
    const request = {
      requestId: "add-sam",
      displayName: "Sam",
      handle: "sam",
      password: MEMBER_PASSWORD,
      role: "member",
    };
    const added = await admin.post("/api/humans", request);
    const again = await admin.post("/api/humans", request);
    expect(added.json).toMatchObject({ handle: "sam", displayName: "Sam", role: "member" });
    expect(again.json, "the same human").toEqual(added.json);
    expect(((await admin.get("/api/humans")).json as Human[]).length, "no second one").toBe(2);

    const secret = await channel(admin, "secret", "private");
    await say(admin, secret, "admins only? no.");
    const member = site.browser();
    expect((await member.logIn("sam", MEMBER_PASSWORD)).status).toBe(200);
    const conversations = (await member.get("/api/chat/conversations")).json as {
      conversationId: number;
    }[];
    expect(
      conversations.map((c) => c.conversationId),
      "every conversation",
    ).toContain(secret);
    const history = (await member.get(`/api/chat/history?conversation=${secret}`)).json as History;
    expect(history.map((entry) => entry.body)).toContain("admins only? no.");

    expect(refusal(await member.get("/api/admin/agents"))).toEqual([403, "admin-only"]);
    expect(refusal(await member.post("/api/admin/pairing-tokens"))).toEqual([403, "admin-only"]);
    expect(refusal(await member.get("/api/humans"))).toEqual([403, "admin-only"]);
    expect(
      refusal(await member.post("/api/humans", { ...request, requestId: "add-another" })),
      "a member cannot add humans",
    ).toEqual([403, "admin-only"]);
    expect(
      refusal(await member.send("POST", "/api/humans", { body: "not json" })),
      "refused before the body is looked at",
    ).toEqual([403, "admin-only"]);
    expect(((await admin.get("/api/humans")).json as Human[]).length).toBe(2);
  });

  it("refuses an added human whose handle is taken before creating anything, and a short password", async () => {
    const { admin } = await adminSite();
    const refused = await admin.post("/api/humans", {
      requestId: "taken",
      displayName: "Another",
      handle: "ADMIN",
      password: MEMBER_PASSWORD,
      role: "member",
    });
    expect(refusal(refused)).toEqual([409, "handle-taken"]);
    const short = await admin.post("/api/humans", {
      requestId: "short",
      displayName: "Shorty",
      handle: "shorty",
      password: "too short",
      role: "member",
    });
    expect(refusal(short)).toEqual([400, "invalid-input"]);
    expect(((await admin.get("/api/humans")).json as Human[]).length).toBe(1);
  });

  it("makes each human act as themselves: the author of their messages, and their own unread", async () => {
    const { site, admin } = await adminSite();
    const { human, member } = await memberOf(site, admin);
    const adminAccount = ((await admin.get("/api/me")).json as Human).accountId;
    const general = await channel(admin, "general");

    await member.post(`/api/chat/conversations/${general}/join`, { requestId: "sam-joins" });
    await say(admin, general, "hello from the admin");
    const unread = async (browser: Browser) =>
      ((await browser.get("/api/chat/unread")).json as { total: number }).total;
    expect(await unread(member), "the member has not read it").toBe(1);
    expect(await unread(admin), "the admin wrote it").toBe(0);

    await member.post("/api/chat/read", {
      timeline: { conversation: general },
      requestId: "member-reads",
    });
    expect(await unread(member)).toBe(0);
    const sent = await say(member, general, "hello from sam");
    expect(sent.status, sent.text).toBe(200);
    expect(await unread(admin), "the admin's unread is the admin's own").toBe(1);

    const history = (await admin.get(`/api/chat/history?conversation=${general}`)).json as History;
    expect(history.map((entry) => [entry.author, entry.body])).toEqual(
      expect.arrayContaining([
        [adminAccount, "hello from the admin"],
        [human.accountId, "hello from sam"],
      ]),
    );
    expect(history.length, "nothing else").toBe(2);
  });
});

describe("11.2 humans: their own profile", () => {
  it("lets a human rename themselves and change their handle, log in with the new handle afterwards, and refuses a taken one", async () => {
    const { site, admin } = await adminSite();
    const { member } = await memberOf(site, admin);

    const renamed = await member.request("PATCH", "/api/me", {
      displayName: "Samuel",
      handle: "samuel",
    });
    expect(renamed.json).toMatchObject({ handle: "samuel", displayName: "Samuel", role: "member" });
    expect((await member.get("/api/me")).json).toMatchObject({ handle: "samuel" });
    expect((await site.browser().logIn("sam", MEMBER_PASSWORD)).status, "the old handle").toBe(401);
    expect((await site.browser().logIn("samuel", MEMBER_PASSWORD)).status).toBe(200);

    expect(
      refusal(await member.request("PATCH", "/api/me", { displayName: "Sam", handle: "Admin" })),
    ).toEqual([409, "handle-taken"]);
    expect(
      refusal(await member.request("PATCH", "/api/me", { displayName: "", handle: "samuel" })),
    ).toEqual([400, "invalid-input"]);
    expect((await member.get("/api/me")).json).toMatchObject({
      handle: "samuel",
      displayName: "Samuel",
    });
  });

  it("changes a human's password on the current one, ends their other sessions and keeps this one", async () => {
    const { site, admin } = await adminSite();
    const { member } = await memberOf(site, admin);
    const other = site.browser();
    await other.logIn("sam", MEMBER_PASSWORD);

    expect(
      refusal(
        await member.post("/api/me/password", { current: "not it", next: "a new long password" }),
      ),
    ).toEqual([403, "wrong-password"]);
    expect(
      refusal(await member.post("/api/me/password", { current: MEMBER_PASSWORD, next: "short" })),
    ).toEqual([400, "invalid-input"]);
    expect((await other.get("/api/me")).status, "nothing changed yet").toBe(200);

    const changed = await member.post("/api/me/password", {
      current: MEMBER_PASSWORD,
      next: "a new long password",
    });
    expect(changed.status, changed.text).toBe(204);
    expect((await member.get("/api/me")).status, "this session goes on").toBe(200);
    expect((await other.get("/api/me")).status, "the other one ended").toBe(401);
    expect((await site.browser().logIn("sam", MEMBER_PASSWORD)).status).toBe(401);
    expect((await site.browser().logIn("sam", "a new long password")).status).toBe(200);
  });
});

describe("11.2 humans: managed by an admin", () => {
  it("lets an admin set a human's password, which ends that human's sessions and no one else's", async () => {
    const { site, admin } = await adminSite();
    const { human, member } = await memberOf(site, admin);

    expect(
      refusal(await admin.post(`/api/humans/${human.accountId}/password`, { password: "short" })),
    ).toEqual([400, "invalid-input"]);
    const reset = await admin.post(`/api/humans/${human.accountId}/password`, {
      password: "reset by the admin",
    });
    expect(reset.status, reset.text).toBe(204);

    expect((await member.get("/api/me")).status, "the member's session ended").toBe(401);
    expect((await admin.get("/api/me")).status, "the admin's did not").toBe(200);
    expect((await site.browser().logIn("sam", MEMBER_PASSWORD)).status).toBe(401);
    expect((await site.browser().logIn("sam", "reset by the admin")).status).toBe(200);
  });

  it("makes a promoted member an admin on their next request, and a demoted admin a member", async () => {
    const { site, admin } = await adminSite();
    const { human, member } = await memberOf(site, admin);
    expect(refusal(await member.get("/api/admin/agents"))).toEqual([403, "admin-only"]);

    const promoted = await admin.post(`/api/humans/${human.accountId}/role`, { role: "admin" });
    expect(promoted.json).toMatchObject({ handle: "sam", role: "admin" });
    expect((await member.get("/api/admin/agents")).status, "no new login needed").toBe(200);

    const adminAccount = ((await admin.get("/api/me")).json as Human).accountId;
    await member.post(`/api/humans/${adminAccount}/role`, { role: "member" });
    expect(refusal(await admin.get("/api/admin/agents"))).toEqual([403, "admin-only"]);
  });

  it("refuses to demote or deactivate the last admin, until another admin exists", async () => {
    const { site, admin } = await adminSite();
    const { human } = await memberOf(site, admin);
    const adminAccount = ((await admin.get("/api/me")).json as Human).accountId;

    expect(
      refusal(await admin.post(`/api/humans/${adminAccount}/role`, { role: "member" })),
    ).toEqual([409, "last-admin"]);
    expect(refusal(await admin.post(`/api/humans/${adminAccount}/deactivate`))).toEqual([
      409,
      "last-admin",
    ]);
    expect((await admin.get("/api/admin/agents")).status, "still an admin and logged in").toBe(200);

    await admin.post(`/api/humans/${human.accountId}/role`, { role: "admin" });
    expect(
      (await admin.post(`/api/humans/${adminAccount}/role`, { role: "member" })).status,
      "the old admin can be demoted now",
    ).toBe(200);
    const promoted = site.browser();
    await promoted.logIn("sam", MEMBER_PASSWORD);
    expect(refusal(await promoted.post(`/api/humans/${human.accountId}/deactivate`))).toEqual([
      409,
      "last-admin",
    ]);
  });

  it("deactivates a human for good: their stream ends with login, they cannot log in, and their messages stay readable", async () => {
    const { site, admin } = await adminSite();
    const { human, member } = await memberOf(site, admin);
    const general = await channel(admin, "general");
    await member.post(`/api/chat/conversations/${general}/join`, { requestId: "sam-joins" });
    expect((await say(member, general, "sam was here")).status).toBe(200);
    const { cursor } = (await member.get("/api/chat/snapshot")).json as { cursor: string };
    const stream = await member.stream(`/api/chat/events?cursor=${encodeURIComponent(cursor)}`);

    const deactivated = await admin.post(`/api/humans/${human.accountId}/deactivate`);
    expect(deactivated.status, deactivated.text).toBe(204);

    await say(admin, general, "after the deactivation");
    await stream.ended;
    expect(stream.events.map((event) => event.event)).toEqual(["login"]);
    expect((await member.get("/api/me")).status).toBe(401);
    expect((await site.browser().logIn("sam", MEMBER_PASSWORD)).status).toBe(401);
    const listed = ((await admin.get("/api/humans")).json as Human[]).find(
      (candidate) => candidate.accountId === human.accountId,
    );
    expect(listed).toMatchObject({ handle: "sam", active: false });
    const history = (await admin.get(`/api/chat/history?conversation=${general}`)).json as History;
    expect(history.map((entry) => entry.body)).toContain("sam was here");
    expect(
      (await admin.post(`/api/humans/${human.accountId}/deactivate`)).status,
      "deactivating again changes nothing",
    ).toBe(204);
  });

  it("answers 404 unknown-account for an account that is not a human", async () => {
    const { admin } = await adminSite();
    expect(refusal(await admin.post("/api/humans/9999/role", { role: "member" }))).toEqual([
      404,
      "unknown-account",
    ]);
  });
});
