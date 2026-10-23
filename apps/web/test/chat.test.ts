import { describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { DAY_MS, newPage, openApp, signIn, startSite } from "./support.ts";

const composer = (page: Page) => page.getByLabel("消息", { exact: true });
const messages = (page: Page, text: string) => page.getByRole("article").filter({ hasText: text });
const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

/** Makes the browser deliver every live batch twice, as a reconnect that replays events would. */
const REPLAY_EVENTS = `(() => {
  const Native = window.EventSource;
  window.EventSource = class extends Native {
    addEventListener(type, listener, options) {
      super.addEventListener(type, (event) => {
        listener.call(this, event);
        if (type === "events") listener.call(this, event);
      }, options);
    }
  };
})()`;

/** A gate a test opens when it wants held requests to go on. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

describe("the chat page", () => {
  it("a message sent while the live stream is still connecting arrives once it is open, for the channel the page opened on", async () => {
    const site = await startSite();
    const general = await site.owner.channel("general");
    await site.owner.say(general, "before the page");
    const { page } = await newPage(site);
    const stream = gate();
    await page.route("**/api/chat/events*", async (route) => {
      await stream.opened;
      await route.continue();
    });
    await signIn(page, site, `/app/c/${general}`);
    await messages(page, "before the page").waitFor();
    await site.owner.say(general, "while connecting");
    expect(await messages(page, "while connecting").count(), "not shown before the stream").toBe(0);
    stream.open();
    await messages(page, "while connecting").waitFor();
  });

  it("a message that arrives while a channel's history is still loading is not lost", async () => {
    const site = await startSite();
    const general = await site.owner.channel("general");
    const random = await site.owner.channel("random");
    await site.owner.say(random, "already there");
    const { page } = await openApp(site);
    const history = gate();
    const read = gate();
    await page.route(new RegExp(`/api/chat/history\\?conversation=${random}\\b`), async (route) => {
      const response = await route.fetch();
      read.open();
      await history.opened;
      await route.fulfill({ response });
    });
    await page.getByRole("link", { name: /random/ }).click();
    await read.opened;
    await site.owner.say(random, "arrived during the load");
    // The live event is applied before the held history response is released.
    await settle(500);
    history.open();
    await messages(page, "already there").waitFor();
    await messages(page, "arrived during the load").waitFor();
    expect(general).toBeGreaterThan(0);
  });

  it("a replayed live event adds neither a second message nor a reply to a thread's count", async () => {
    const site = await startSite();
    const general = await site.owner.channel("general");
    const { page } = await newPage(site);
    await page.addInitScript(REPLAY_EVENTS);
    await signIn(page, site, `/app/c/${general}`);
    await page.getByRole("navigation", { name: "会话" }).waitFor();
    const root = await site.owner.say(general, "the root");
    await messages(page, "the root").waitFor();
    await site.owner.say(general, "first reply", root.messageId);
    await messages(page, "the root").getByText("1 条回复").waitFor();
    await site.owner.say(general, "second reply", root.messageId);
    await messages(page, "the root").getByText("2 条回复").waitFor();
    await settle();
    expect(await messages(page, "the root").count(), "one message, not two").toBe(1);
    expect(await page.getByText("3 条回复").count()).toBe(0);
  });

  it("a slow response for the channel the owner left does not replace the channel they are in", async () => {
    const site = await startSite();
    const alpha = await site.owner.channel("alpha");
    const beta = await site.owner.channel("beta");
    await site.owner.say(alpha, "text of alpha");
    await site.owner.say(beta, "text of beta");
    const { page } = await openApp(site);
    const slow = gate();
    let held = false;
    await page.route(new RegExp(`/api/chat/history\\?conversation=${alpha}\\b`), async (route) => {
      held = true;
      const response = await route.fetch();
      await slow.opened;
      await route.fulfill({ response });
    });
    await page.getByRole("link", { name: /alpha/ }).click();
    await page.getByRole("link", { name: /beta/ }).click();
    await messages(page, "text of beta").waitFor();
    expect(held, "alpha's history was the slow one").toBe(true);
    slow.open();
    await settle();
    expect(await messages(page, "text of alpha").count()).toBe(0);
    expect(await messages(page, "text of beta").count()).toBe(1);
  });

  it("text typed while a message is being sent is still in the composer when the send succeeds", async () => {
    const site = await startSite();
    const general = await site.owner.channel("general");
    const { page } = await openApp(site, `/app/c/${general}`);
    const sending = gate();
    await page.route("**/api/chat/messages", async (route) => {
      await sending.opened;
      await route.continue();
    });
    await composer(page).fill("first");
    await composer(page).press("Enter");
    await page.getByText("发送中…").waitFor();
    await composer(page).pressSequentially("second");
    sending.open();
    await messages(page, "first").waitFor();
    await expect.poll(() => composer(page).inputValue()).toBe("second");
  });

  it("sending again after the response was lost does not make a second message", async () => {
    const site = await startSite();
    const general = await site.owner.channel("general");
    const { page } = await openApp(site, `/app/c/${general}`);
    const requests: string[] = [];
    let lost = true;
    await page.route("**/api/chat/messages", async (route) => {
      requests.push(route.request().postData() ?? "");
      if (!lost) return route.continue();
      lost = false;
      await route.fetch();
      await route.abort("connectionreset");
    });
    await composer(page).fill("exactly once");
    await composer(page).press("Enter");
    await page.getByRole("button", { name: "重试发送" }).click();
    await messages(page, "exactly once").waitFor();
    await settle();
    expect(requests).toHaveLength(2);
    const ids = requests.map((body) => (JSON.parse(body) as { requestId: string }).requestId);
    expect(ids[0], "the retry is the same request").toBe(ids[1]);
    const history = await site.owner.get<unknown[]>(`/api/chat/history?conversation=${general}`);
    expect(history, "the server holds one message").toHaveLength(1);
    expect(await messages(page, "exactly once").count()).toBe(1);
  });

  it("after the live stream says to take a new snapshot, the page loads its state again and keeps following", async () => {
    const site = await startSite();
    const general = await site.owner.channel("general");
    const { page } = await newPage(site);
    const stale = gate();
    let first = true;
    await page.route("**/api/chat/events*", async (route) => {
      if (!first) return route.continue();
      first = false;
      await stale.opened;
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: 'event: resnapshot\ndata: {"status":"resnapshot"}\n\n',
      });
    });
    let snapshots = 0;
    page.on("request", (request) => {
      if (request.url().includes("/api/chat/snapshot")) snapshots += 1;
    });
    await signIn(page, site, `/app/c/${general}`);
    await page.getByRole("navigation", { name: "会话" }).waitFor();
    await site.owner.say(general, "said while the stream was stale");
    stale.open();
    await messages(page, "said while the stream was stale").waitFor();
    expect(snapshots, "a second snapshot was loaded").toBe(2);
    await site.owner.say(general, "said after the reload");
    await messages(page, "said after the reload").waitFor();
  });

  it("when the session ends the page goes to the login page, and logging in returns to the same place", async () => {
    const site = await startSite();
    const general = await site.owner.channel("general");
    const { page } = await openApp(site, `/app/c/${general}`);
    site.clock.advance(31 * DAY_MS);
    await page.waitForURL(`**/login?next=${encodeURIComponent(`/app/c/${general}`)}`);
    await signIn(page, site, `/app/c/${general}`);
    await page.waitForURL(`${site.origin}/app/c/${general}`);
    await page.getByRole("heading", { name: "general" }).waitFor();
  });

  it("a request refused as logged out sends the page to the login page", async () => {
    const site = await startSite();
    const general = await site.owner.channel("general");
    const { page, context } = await openApp(site, `/app/c/${general}`);
    await context.clearCookies();
    await page.getByRole("button", { name: "新建会话" }).click();
    await page.getByLabel("频道名称").fill("after logout");
    await page.getByRole("button", { name: "创建频道" }).click();
    await page.waitForURL(/\/login\?next=/);
  });

  it("a link from a notification shows the message it names, even one far back, and says so when the message is gone", async () => {
    const site = await startSite();
    const general = await site.owner.channel("general");
    for (let n = 1; n <= 120; n += 1) await site.owner.say(general, `numbered ${n}`);
    const { page } = await openApp(site, `/app/c/${general}?seq=7`);
    await page.locator('[data-seq="7"][data-highlighted]').waitFor();
    expect(await page.locator('[data-seq="7"]').textContent()).toContain("numbered 7");

    await page.goto(`${site.origin}/app/c/${general}?seq=9999`);
    await page.getByRole("status").filter({ hasText: "找不到那条消息" }).waitFor();
    await messages(page, "numbered 120").waitFor();
  });

  it("a notification link into a thread shows that thread's reply", async () => {
    const site = await startSite();
    const general = await site.owner.channel("general");
    const root = await site.owner.say(general, "thread root");
    await site.owner.say(general, "first answer", root.messageId);
    const second = await site.owner.say(general, "second answer", root.messageId);
    const { page } = await openApp(site, `/app/c/${general}/t/${root.messageId}?seq=${second.seq}`);
    const pane = page.getByRole("complementary", { name: "讨论串" });
    const target = pane.locator(`[data-seq="${second.seq}"][data-highlighted]`);
    await target.waitFor();
    await messages(page, "first answer").waitFor();
    const inside = await Promise.all([target.boundingBox(), pane.boundingBox()]);
    const [t, p] = inside;
    expect(
      t !== null && p !== null && t.y >= p.y && t.y + t.height <= p.y + p.height,
      "the highlighted reply is in the thread pane's viewport",
    ).toBe(true);
  });

  it("works at a phone's width: the list, a conversation, sending, and back", async () => {
    const site = await startSite();
    const general = await site.owner.channel("general");
    await site.owner.say(general, "hello from the desk");
    const { page } = await openApp(site, "/app", { width: 390, height: 780 });
    const fits = () =>
      page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(await fits(), "the list fits the screen").toBe(true);
    await page.getByRole("link", { name: /general/ }).click();
    await messages(page, "hello from the desk").waitFor();
    await composer(page).fill("hi from the phone");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await messages(page, "hi from the phone").waitFor();
    expect(await fits(), "the conversation fits the screen").toBe(true);
    const box = await composer(page).boundingBox();
    expect(
      box !== null && box.x >= 0 && box.x + box.width <= 390,
      "the composer is on screen",
    ).toBe(true);
    await page.getByRole("link", { name: "返回会话列表" }).click();
    await page.getByRole("link", { name: /general/ }).waitFor();
  });
});

describe("conversations", () => {
  it("the owner creates a channel, writes in it, and finds the message after a reload", async () => {
    const site = await startSite();
    const { page } = await openApp(site);
    await page.getByRole("button", { name: "新建会话" }).click();
    await page.getByLabel("频道名称").fill("launch");
    await page.getByRole("button", { name: "创建频道" }).click();
    await page.getByRole("heading", { name: "launch" }).waitFor();
    await composer(page).fill("we ship on friday");
    await composer(page).press("Enter");
    await messages(page, "we ship on friday").waitFor();
    await expect
      .poll(() => composer(page).inputValue(), { message: "sent text leaves the composer" })
      .toBe("");
    await page.reload();
    await messages(page, "we ship on friday").waitFor();
  });

  it("unread counts show on the list and clear once the owner has looked at the conversation", async () => {
    const site = await startSite();
    const general = await site.owner.channel("general");
    const other = await site.owner.channel("other");
    const agent = await site.agent("sam");
    await site.owner.post(`/api/chat/conversations/${general}/invite`, {
      requestId: "invite",
      invitee: agent.accountId,
    });
    const { page } = await openApp(site, `/app/c/${other}`);
    await agent.say(general, "news for you");
    const row = page.getByRole("link", { name: /general/ });
    await row.getByLabel("1 条未读").waitFor();
    await row.click();
    await messages(page, "news for you").waitFor();
    await expect.poll(() => row.getByLabel(/条未读/).count()).toBe(0);
  });

  it("leaving, rejoining and archiving a channel change what the owner can do in it", async () => {
    const site = await startSite();
    const general = await site.owner.channel("general");
    const { page } = await openApp(site, `/app/c/${general}`);
    await page.getByRole("button", { name: "更多" }).click();
    await page.getByRole("menuitem", { name: "离开频道" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "离开", exact: true }).click();
    await page.getByText("你还没有加入这个频道").waitFor();
    await page.getByRole("button", { name: "加入", exact: true }).click();
    await composer(page).waitFor();
    await page.getByRole("button", { name: "更多" }).click();
    await page.getByRole("menuitem", { name: "归档频道" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "归档", exact: true }).click();
    await page.getByText("这个频道已归档，只能阅读。").waitFor();
    expect(await composer(page).count()).toBe(0);
  });

  it("the owner archives a channel they are not a member of", async () => {
    const site = await startSite();
    const general = await site.owner.channel("general");
    const { page } = await openApp(site, `/app/c/${general}`);
    await page.getByRole("button", { name: "更多" }).click();
    await page.getByRole("menuitem", { name: "离开频道" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "离开", exact: true }).click();
    await page.getByText("你还没有加入这个频道").waitFor();
    await page.getByRole("button", { name: "更多" }).click();
    expect(await page.getByRole("menuitem", { name: "离开频道" }).count()).toBe(0);
    await page.getByRole("menuitem", { name: "归档频道" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "归档", exact: true }).click();
    await page.getByText("这个频道已归档，只能阅读。").waitFor();
    await page.getByText("已归档", { exact: false }).first().waitFor();
  });

  it("the owner invites an Agent into a channel and opens a direct message with it", async () => {
    const site = await startSite();
    const general = await site.owner.channel("general");
    await site.agent("sam");
    const { page } = await openApp(site, `/app/c/${general}`);
    await page.getByRole("button", { name: "邀请" }).click();
    await page.getByLabel("邀请谁").selectOption({ label: "Sam（@sam）" });
    await page.getByRole("dialog").getByRole("button", { name: "邀请" }).click();
    await page.getByText("2 位成员").waitFor();
    await page.getByRole("button", { name: "新建会话" }).click();
    await page.getByRole("tab", { name: "私信" }).click();
    await page.getByLabel("对方").selectOption({ label: "Sam（@sam）" });
    await page.getByRole("button", { name: "打开私信" }).click();
    await page.getByRole("heading", { name: "Sam" }).waitFor();
    await page.getByText("私信 ·").waitFor();
  });

  it("a search lists the messages containing the words", async () => {
    const site = await startSite();
    const general = await site.owner.channel("general");
    await site.owner.say(general, "the needle is here");
    await site.owner.say(general, "only hay here");
    const { page } = await openApp(site);
    await page.getByRole("searchbox", { name: "搜索消息" }).fill("needle");
    await page.getByRole("searchbox", { name: "搜索消息" }).press("Enter");
    await page.getByText("the needle is here").waitFor();
    expect(await page.getByText("only hay here").count()).toBe(0);
  });

  it("an older page of history loads on request without losing the newer messages", async () => {
    const site = await startSite();
    const general = await site.owner.channel("general");
    for (let n = 1; n <= 60; n += 1) await site.owner.say(general, `line ${n}`);
    const { page } = await openApp(site, `/app/c/${general}`);
    await messages(page, "line 60").waitFor();
    expect(await page.locator(`[data-seq="5"]`).count(), "line 5 is on the older page").toBe(0);
    await page.getByRole("button", { name: "加载更早的消息" }).click();
    await page.locator('[data-seq="1"]').waitFor();
    await messages(page, "line 60").waitFor();
    expect(await page.getByRole("button", { name: "加载更早的消息" }).count()).toBe(0);
  });

  it("a task made from a message can be claimed and completed", async () => {
    const site = await startSite();
    const general = await site.owner.channel("general");
    await site.owner.say(general, "the quarterly report is due");
    const { page } = await openApp(site, `/app/c/${general}`);
    const message = messages(page, "the quarterly report");
    await message.getByRole("button", { name: "转为任务" }).click();
    await message.getByLabel("任务标题").fill("Write the report");
    await message.getByRole("button", { name: "创建任务" }).click();
    await message.getByText("无人认领").waitFor();
    await message.getByRole("button", { name: "认领" }).click();
    await message.getByText("admin").first().waitFor();
    await message.getByRole("button", { name: "完成" }).click();
    await message.getByText("已完成").waitFor();
    await page.getByText("admin 完成了任务「Write the report」").waitFor();
  });

  it("an Agent's messages carry its generated avatar, and the owner's carry an initial", async () => {
    const site = await startSite();
    const general = await site.owner.channel("general");
    const agent = await site.agent("sam");
    await site.owner.post(`/api/chat/conversations/${general}/invite`, {
      requestId: "invite",
      invitee: agent.accountId,
    });
    await site.owner.say(general, "from the owner");
    await agent.say(general, "from the agent");
    const { page } = await openApp(site, `/app/c/${general}`);
    await messages(page, "from the agent").waitFor();
    await expect
      .poll(() => messages(page, "from the agent").locator("img").getAttribute("src"))
      .toBe(`https://api.dicebear.com/10.x/thumbs/svg?seed=${agent.accountId}`);
    expect(await messages(page, "from the owner").locator("img").count()).toBe(0);
  });
});
