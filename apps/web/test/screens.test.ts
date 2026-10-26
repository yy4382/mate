import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";
import { newPage, signIn, startSite } from "./support.ts";

/** Screenshots of every page, for looking at the interface rather than testing it: `MATE_SCREENS=<dir> pnpm vitest run apps/web/test/screens.test.ts`. */
const out = process.env.MATE_SCREENS;

const VIEWS = [
  { name: "desktop", viewport: { width: 1280, height: 800 }, colorScheme: "light" },
  { name: "desktop-dark", viewport: { width: 1280, height: 800 }, colorScheme: "dark" },
  { name: "phone", viewport: { width: 390, height: 844 }, colorScheme: "light" },
] as const;

it.runIf(out !== undefined)(
  "screens",
  async () => {
    const dir = out as string;
    mkdirSync(dir, { recursive: true });
    const site = await startSite();
    const general = await site.owner.channel("general");
    await site.owner.channel("random");
    const ada = await site.agent("ada");
    const picture = (color: string) =>
      readFileSync(
        new URL(`../../../tests/fixtures/avatars/${color}.png`, import.meta.url),
      ).toString("base64");
    await site.owner.put("/api/me/avatar", {
      requestId: "screen-human-avatar",
      png: picture("red"),
    });
    await site.owner.put(`/api/accounts/${ada.accountId}/avatar`, {
      requestId: "screen-agent-avatar",
      png: picture("blue"),
    });
    await site.owner.put(`/api/admin/nodes/${ada.nodeId}`, { name: "legacy-server" });
    const nodeId = await site.pairNode({
      system: {
        platform: "linux",
        arch: "arm64",
        hostname: "build-server.local",
        osRelease: "6.8.0-64-generic",
        version: "v0.1.0-alpha.3",
      },
    });
    await site.owner.put(`/api/admin/agents/${ada.agentId}/nodes/${nodeId}`);
    await site.pairNode({
      system: {
        platform: "darwin",
        arch: "arm64",
        hostname: "laptop",
        osRelease: "25.0.0",
        version: "v0.1.0-alpha.3",
      },
    });
    await site.owner.post(`/api/chat/conversations/${general}/invite`, {
      requestId: randomUUID(),
      invitee: ada.accountId,
    });
    const root = await site.owner.say(general, "@ada 帮我看一下今天的部署日志，有没有报错？");
    await ada.say(
      general,
      "看过了，部署日志里没有错误。有两个 warning 是关于 node 心跳延迟的，不影响功能。",
    );
    await site.owner.say(general, "好的，谢谢", root.messageId);
    await site.owner.say(general, "下午再跑一次 smoke test");
    await site.owner.post("/api/chat/tasks", {
      requestId: randomUUID(),
      messageId: root.messageId,
      title: "检查部署日志",
    });

    await site.owner.post("/api/humans", {
      requestId: randomUUID(),
      handle: "mei",
      displayName: "Mei",
      password: "member password 123",
      role: "member",
    });

    const pages: [string, string][] = [
      ["chat-list", "/app"],
      ["chat", `/app/c/${general}`],
      ["chat-thread", `/app/c/${general}/t/${root.messageId}`],
      ["search", "/app/search?q=部署"],
      ["agents", "/app/admin/agents"],
      ["agent", `/app/admin/agents/${ada.agentId}`],
      ["providers", "/app/admin/providers"],
      ["nodes", "/app/admin/nodes"],
      ["humans", "/app/admin/humans"],
      ["profile", "/app/profile"],
    ];
    for (const view of VIEWS) {
      const { page, context } = await newPage(site, view.viewport);
      await page.emulateMedia({ colorScheme: view.colorScheme });
      await page.goto(`${site.origin}/login`);
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(dir, `${view.name}-login.png`) });
      await signIn(page, site);
      for (const [name, path] of pages) {
        await page.goto(site.origin + path);
        await page.waitForTimeout(600);
        await page.screenshot({ path: join(dir, `${view.name}-${name}.png`) });
        if (name === "agent") {
          const access = page.getByRole("region", { name: "Node 访问" });
          await access.scrollIntoViewIfNeeded();
          await page.screenshot({ path: join(dir, `${view.name}-node-access.png`) });
        }
      }
      await page.goto(`${site.origin}/app/c/${general}`);
      await page.waitForTimeout(600);
      await page.getByText("下午再跑一次 smoke test").hover();
      await page.screenshot({ path: join(dir, `${view.name}-chat-hover.png`) });
      await context.close();
    }
  },
  120_000,
);
