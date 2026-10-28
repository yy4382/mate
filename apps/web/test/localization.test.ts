/// <reference lib="webworker" />
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { PASSWORD, newPage, startSite, webDirectory } from "./support.ts";

it.each([
  { languages: ["zh-CN", "en-US"], lang: "zh-CN", heading: "登录 Mate" },
  { languages: ["zh-Hant-TW", "en"], lang: "zh-CN", heading: "登录 Mate" },
  { languages: ["en-GB", "zh"], lang: "en-US", heading: "Sign in to Mate" },
  { languages: ["fr-FR", "zh-HK", "en"], lang: "zh-CN", heading: "登录 Mate" },
  { languages: ["ja-JP", "en-AU", "zh"], lang: "en-US", heading: "Sign in to Mate" },
  { languages: ["fr-FR", "ja"], lang: "en-US", heading: "Sign in to Mate" },
  { languages: [], lang: "en-US", heading: "Sign in to Mate" },
])(
  "the browser matches $languages in preference order and ignores saved overrides",
  async ({ languages, lang, heading }) => {
    const site = await startSite();
    const { page, context } = await newPage(site);
    await context.addInitScript((preferred) => {
      Object.defineProperty(navigator, "languages", { get: () => preferred });
      Object.defineProperty(navigator, "language", { get: () => preferred[0] ?? "" });
      localStorage.setItem("i18nextLng", preferred[0]?.startsWith("zh") ? "en" : "zh");
      document.cookie = "i18next=zh";
    }, languages);
    await page.goto(`${site.origin}/login?lng=zh`);
    await page.getByRole("heading", { name: heading }).waitFor();
    expect(await page.locator("html").getAttribute("lang")).toBe(lang);
    const href = await page.locator('link[rel="manifest"]').getAttribute("href");
    const manifest = await (await page.request.get(new URL(href ?? "", site.origin).href)).json();
    expect(manifest.lang).toBe(lang === "zh-CN" ? "zh-CN" : "en");
  },
);

const COPY = {
  en: {
    locale: "en-US",
    password: "Password",
    signIn: "Sign in",
    wrong: "Incorrect handle or password.",
    nav: "Main navigation",
    empty: "Choose a conversation",
    message: "Message",
    members: "1 member",
    task: 'admin created task "Original 任务"',
    reply: "1 reply",
    replies: "2 replies",
    search: 'Search for "unmatched词"',
    noMatches: "No matching messages.",
    agents: "Agents",
    create: "Create Agent",
    emptyAgents: "No Agents yet.",
    providers: "Model providers",
    nodes: "Nodes",
    humans: "Humans",
    profile: "Profile",
    settings: "Settings",
    observe: "Observe",
    workspace: "Workspace",
    root: "Root directory",
    access: "Node access",
    offline: "Node is offline. Try again when it reconnects.",
    paused: "Agent is not running",
    rename: "Rename",
    renameTitle: "Rename node",
    cancel: "Cancel",
    denied: "Administrator access required",
    noPage: "Page not found",
  },
  zh: {
    locale: "zh-CN",
    password: "密码",
    signIn: "登录",
    wrong: "Handle 或密码不对。",
    nav: "主导航",
    empty: "选择一个会话",
    message: "消息",
    members: "1 位成员",
    task: "admin 创建了任务「Original 任务」",
    reply: "1 条回复",
    replies: "2 条回复",
    search: "搜索「unmatched词」",
    noMatches: "没有找到匹配的消息。",
    agents: "Agent",
    create: "创建 Agent",
    emptyAgents: "还没有 Agent。",
    providers: "模型提供商",
    nodes: "Node",
    humans: "人类",
    profile: "个人资料",
    settings: "设置",
    observe: "观察",
    workspace: "工作区",
    root: "根目录",
    access: "Node 访问",
    offline: "Node 离线，请在它重新连接后重试。",
    paused: "Agent 没有在运行",
    rename: "改名",
    renameTitle: "修改 Node 名字",
    cancel: "取消",
    denied: "需要管理员权限",
    noPage: "找不到这个页面",
  },
} as const;

it.each(["en", "zh"] as const)(
  "%s localizes navigation, counts, errors and empty states without changing content",
  async (language) => {
    const copy = COPY[language];
    const site = await startSite();
    const { page } = await newPage(site, undefined, copy.locale);
    await page.goto(`${site.origin}/login`);
    await page.getByLabel("Handle", { exact: true }).fill("admin");
    await page.getByLabel(copy.password, { exact: true }).fill("incorrect password");
    await page.getByRole("button", { name: copy.signIn, exact: true }).click();
    await expect.poll(() => page.getByRole("alert").textContent()).toBe(copy.wrong);
    await page.getByLabel(copy.password, { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: copy.signIn, exact: true }).click();
    await page.getByRole("navigation", { name: copy.nav }).waitFor();
    await page.getByText(copy.empty, { exact: true }).waitFor();
    for (const [path, heading] of [
      ["/app/admin/agents", copy.agents],
      ["/app/admin/providers", copy.providers],
      ["/app/admin/nodes", copy.nodes],
      ["/app/admin/humans", copy.humans],
      ["/app/profile", copy.profile],
      ["/app/unknown", copy.noPage],
    ] as const) {
      await page.goto(site.origin + path);
      await page.getByRole("heading", { name: heading, exact: true }).waitFor();
    }
    await page.goto(`${site.origin}/app/admin/agents`);
    await page.getByText(copy.emptyAgents, { exact: true }).waitFor();
    await page.getByRole("button", { name: copy.create }).click();
    const create = page.getByRole("dialog");
    await create.getByRole("link", { name: copy.nodes, exact: true }).waitFor();
    await create
      .getByRole("link", { name: language === "en" ? "Providers" : "提供商", exact: true })
      .waitFor();
    await page.keyboard.press("Escape");

    const channel = await site.owner.channel("Original 中文 channel");
    const root = await site.owner.say(channel, "Original message 消息");
    await site.owner.post("/api/chat/tasks", {
      requestId: randomUUID(),
      messageId: root.messageId,
      title: "Original 任务",
    });
    await page.goto(`${site.origin}/app/c/${channel}`);
    await page.getByRole("heading", { name: "Original 中文 channel", exact: true }).waitFor();
    await page.getByText(copy.members, { exact: false }).waitFor();
    await page.getByRole("article").getByText("Original message 消息", { exact: true }).waitFor();
    await page.getByText(copy.task, { exact: true }).waitFor();
    await site.owner.say(channel, "Reply 原文", root.messageId);
    await page.getByRole("link", { name: copy.reply, exact: true }).waitFor();
    await site.owner.say(channel, "Second reply 第二条", root.messageId);
    await page.getByRole("link", { name: copy.replies, exact: true }).click();
    await page.getByText("Second reply 第二条", { exact: true }).waitFor();
    await page.goto(`${site.origin}/app/search?q=unmatched词`);
    await page.getByRole("heading", { name: copy.search, exact: true }).waitFor();
    await page.getByText(copy.noMatches, { exact: true }).waitFor();

    await site.provider();
    const nodeId = await site.pairNode({
      onBrowse: async (request) =>
        request.path === "unavailable"
          ? { ok: false, reason: "unreadable", message: "node path diagnostic" }
          : request.path === "notes.txt"
            ? {
                ok: true,
                listing: {
                  kind: "file",
                  path: request.path,
                  size: 13,
                  content: "Original 文件",
                  truncated: false,
                },
              }
            : {
                ok: true,
                listing: {
                  kind: "directory",
                  path: request.path,
                  truncated: false,
                  entries:
                    request.path === "."
                      ? [
                          { name: "notes.txt", kind: "file", size: 13 },
                          { name: "empty", kind: "directory" },
                          { name: "unavailable", kind: "directory" },
                        ]
                      : [],
                },
              },
    });
    const agent = await site.owner.post<{ agentId: string }>("/api/admin/agents", {
      nodeId,
      displayName: "Polyglot",
      handle: "polyglot",
      settings: { model: { provider: "openai", modelId: "gpt-4.1" } },
    });
    await site.owner.post(`/api/admin/agents/${agent.agentId}/pause`);
    await page.goto(`${site.origin}/app/admin/agents/${agent.agentId}`);
    await page.getByRole("tab", { name: copy.settings, exact: true }).waitFor();
    await page.getByRole("region", { name: copy.access }).waitFor();
    await page.getByRole("tab", { name: copy.observe, exact: true }).click();
    await page.getByText(copy.paused, { exact: true }).waitFor();
    await page.getByRole("tab", { name: copy.workspace, exact: true }).click();
    await page.getByRole("button", { name: "notes.txt" }).click();
    await expect.poll(() => page.getByTestId("file-content").textContent()).toBe("Original 文件");
    await page.getByRole("button", { name: copy.root, exact: true }).click();
    await page.getByRole("button", { name: "empty", exact: true }).click();
    await page
      .getByText(language === "en" ? "Empty directory" : "空目录", { exact: true })
      .waitFor();
    await page.getByRole("button", { name: copy.root, exact: true }).click();
    await page.getByRole("button", { name: "unavailable", exact: true }).click();
    await expect
      .poll(() => page.getByRole("alert").textContent())
      .toBe(language === "en" ? "This path cannot be read." : "无法读取这个路径。");
    site.disconnectNodes();
    await expect
      .poll(async () =>
        (await site.owner.get<{ online: boolean }[]>("/api/admin/nodes")).every(
          (node) => !node.online,
        ),
      )
      .toBe(true);
    await page.getByRole("button", { name: copy.root, exact: true }).click();
    await expect.poll(() => page.getByRole("alert").textContent()).toBe(copy.offline);
    await page.goto(`${site.origin}/app/admin/nodes`);
    await page.getByRole("button", { name: copy.rename, exact: true }).click();
    await page.getByRole("dialog", { name: copy.renameTitle }).waitFor();
    await page.getByRole("button", { name: copy.cancel, exact: true }).click();

    await site.owner.post("/api/humans", {
      requestId: randomUUID(),
      handle: "reader",
      displayName: "Reader 原名",
      password: PASSWORD,
      role: "member",
    });
    const { page: reader } = await newPage(site, undefined, copy.locale);
    await reader.goto(`${site.origin}/login`);
    await reader.getByLabel("Handle", { exact: true }).fill("reader");
    await reader.getByLabel(copy.password, { exact: true }).fill(PASSWORD);
    await reader.getByRole("button", { name: copy.signIn, exact: true }).click();
    await reader.getByRole("navigation", { name: copy.nav }).waitFor();
    await reader.goto(`${site.origin}/app/admin/agents`);
    await reader.getByText(copy.denied, { exact: true }).waitFor();
  },
);

it.each(["en-US", "zh-CN"])(
  "an existing classic notification worker upgrades and shows %s notifications",
  async (locale) => {
    const site = await startSite();
    const { page, context } = await newPage(site, undefined, locale);
    const script = join(await webDirectory(), "sw.js");
    const current = readFileSync(script, "utf8");
    writeFileSync(
      script,
      'self.addEventListener("install", () => self.skipWaiting()); self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));',
    );
    try {
      await page.goto(`${site.origin}/login`);
      await page.evaluate(async () => {
        const controlled = new Promise<void>((resolve) =>
          navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), {
            once: true,
          }),
        );
        await navigator.serviceWorker.register("/sw.js", { scope: "/" });
        await navigator.serviceWorker.ready;
        if (navigator.serviceWorker.controller === null) await controlled;
      });
    } finally {
      writeFileSync(script, current);
    }
    const replacement = context.waitForEvent("serviceworker");
    await page.evaluate(async () => {
      const controlled = new Promise<void>((resolve) =>
        navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), {
          once: true,
        }),
      );
      const registration = await navigator.serviceWorker.getRegistration("/");
      if (registration === undefined)
        throw new Error("The existing notification registration is missing");
      await registration.update();
      await controlled;
    });
    const worker = await replacement;
    const title = await worker.evaluate(async () => {
      const worker = globalThis as unknown as ServiceWorkerGlobalScope;
      let shown = "";
      Object.defineProperty(worker.registration, "showNotification", {
        value: async (title: string) => {
          shown = title;
        },
      });
      worker.dispatchEvent(
        new PushEvent("push", {
          data: JSON.stringify({
            sender: "Original 名字",
            kind: "dm",
            mentioned: true,
            conversationId: 1,
            timeline: { conversation: 1 },
            seq: 7,
            tag: "localized-notice",
            at: 1,
          }),
        }),
      );
      return shown;
    });
    expect(title).toBe(
      locale === "zh-CN"
        ? "Original 名字 在私信里提到了你"
        : "Original 名字 mentioned you in a direct message",
    );
  },
);
