import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Locator, Page } from "playwright";
import { describe, expect, it, onTestFinished } from "vitest";
import { newPage, openApp, signIn, startSite } from "./support.ts";

const red = readFileSync(new URL("../../../tests/fixtures/avatars/red.png", import.meta.url));
const blue = readFileSync(new URL("../../../tests/fixtures/avatars/blue.png", import.meta.url));
const image = (buffer: Buffer) => ({ name: "avatar.png", mimeType: "image/png", buffer });

async function upload(
  page: Page,
  file: { name: string; mimeType: string; buffer: Buffer },
): Promise<void> {
  const saved = page.waitForResponse(
    (response) => response.request().method() === "PUT" && response.url().endsWith("/avatar"),
  );
  await page.getByLabel("头像图片").setInputFiles(file);
  const response = await saved;
  expect(response.ok()).toBe(true);
  const account = (await response.json()) as { accountId: number; avatarVersion: string };
  await page
    .locator(`img[src="/api/accounts/${account.accountId}/avatar?v=${account.avatarVersion}"]`)
    .first()
    .waitFor({ state: "visible" });
  await page.getByText("头像已保存", { exact: true }).waitFor();
}

async function renderedAvatar(scope: Page | Locator, accountId: number): Promise<string> {
  const picture = scope.locator(`img[src^="/api/accounts/${accountId}/avatar?"]`).first();
  await picture.waitFor({ state: "visible" });
  await expect
    .poll(() =>
      picture.evaluate(
        (element) =>
          element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0,
      ),
    )
    .toBe(true);
  return (await picture.getAttribute("src"))!;
}

describe("uploading account avatars in the browser", () => {
  it("reuses cached pictures across pages and downloads a replacement at its new URL", async () => {
    const site = await startSite();
    const { accountId } = await site.owner.get<{ accountId: number }>("/api/me");
    const { context: routedContext } = await newPage(site);
    // Playwright routing disables HTTP caching, including routes for unrelated hosts.
    const context = await routedContext.browser()!.newContext();
    onTestFinished(() => context.close());
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    await signIn(page, site, "/app/profile");
    await upload(page, image(red));
    const first = await renderedAvatar(page, accountId);
    await page.goto(`${site.origin}/app/admin/humans`);
    expect(await renderedAvatar(page, accountId)).toBe(first);
    const cached = await page.evaluate((path) => {
      const entries = performance.getEntriesByName(new URL(path, location.href).href);
      const resource = entries[0] as PerformanceResourceTiming;
      return { transferred: resource.transferSize, decoded: resource.decodedBodySize };
    }, first);
    expect(cached.transferred).toBe(0);
    expect(cached.decoded).toBeGreaterThan(0);
    await page.goto(`${site.origin}/app/profile`);
    const downloaded = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/accounts/${accountId}/avatar?`) &&
        !response.url().endsWith(first),
    );
    await upload(page, image(blue));
    expect((await downloaded).ok()).toBe(true);
    expect(await renderedAvatar(page, accountId)).not.toBe(first);
  });

  it("a human uploads and replaces their picture, sees it in other pages live and after reload, and restores the default", async () => {
    const site = await startSite();
    const { accountId } = await site.owner.get<{ accountId: number }>("/api/me");
    const channel = await site.owner.channel("pictures");
    await site.owner.say(channel, "My avatar");
    const { page } = await openApp(site, "/app/profile");
    const { page: chat } = await openApp(site, `/app/c/${channel}`);
    const { page: humans } = await openApp(site, "/app/admin/humans");
    expect(await page.locator('img[src^="/api/accounts/"]').count()).toBe(0);
    await upload(page, image(red));
    await page.getByText("头像已保存", { exact: true }).waitFor();
    const first = await renderedAvatar(page, accountId);
    expect(await renderedAvatar(chat, accountId)).toBe(first);
    expect(await renderedAvatar(humans, accountId)).toBe(first);
    await expect.poll(() => chat.locator(`article img[src="${first}"]`).count()).toBe(1);
    expect(
      await page
        .getByRole("button", { name: "admin", exact: true })
        .locator("img")
        .getAttribute("src"),
    ).toBe(first);

    await upload(page, image(blue));
    await expect
      .poll(() =>
        page.getByRole("button", { name: "admin", exact: true }).locator("img").getAttribute("src"),
      )
      .not.toBe(first);
    const second = await renderedAvatar(page, accountId);
    expect(second).not.toBe(first);
    await expect
      .poll(() => humans.locator(`[data-human="admin"] img`).getAttribute("src"))
      .toBe(second);
    await page.reload();
    expect(await renderedAvatar(page, accountId)).toBe(second);
    await page.getByRole("button", { name: "恢复默认头像" }).click();
    await page.getByText("头像已保存", { exact: true }).waitFor();
    await expect.poll(() => page.locator('img[src^="/api/accounts/"]').count()).toBe(0);
    await expect.poll(() => chat.locator('img[src^="/api/accounts/"]').count()).toBe(0);
  });

  it("an admin changes another human's picture while that human sees it live and replaces it from their profile", async () => {
    const site = await startSite();
    const password = "avatar member password";
    const member = await site.owner.post<{ accountId: number }>("/api/humans", {
      requestId: randomUUID(),
      handle: "mei",
      displayName: "Mei",
      password,
      role: "member",
    });
    const { page } = await openApp(site, "/app/admin/humans");
    const { page: profile } = await openApp(site, "/app/profile", undefined, {
      handle: "mei",
      password,
    });
    await page.getByRole("button", { name: "更多：Mei" }).click();
    await page.getByRole("menuitem", { name: "更换头像" }).click();
    const dialog = page.getByRole("dialog", { name: "更换 Mei 的头像" });
    await upload(page, image(red));
    await dialog.getByText("头像已保存", { exact: true }).waitFor();
    expect(await renderedAvatar(profile, member.accountId)).toBe(
      await renderedAvatar(page, member.accountId),
    );
    await upload(profile, image(blue));
    await profile.getByText("头像已保存", { exact: true }).waitFor();
    const replacement = await renderedAvatar(profile, member.accountId);
    await expect
      .poll(() => page.locator('[data-human="mei"] img').first().getAttribute("src"))
      .toBe(replacement);
  });

  it("an Agent's uploaded picture appears in its list, detail, messages, search and DM, and a failed image falls back then recovers on replacement", async () => {
    const site = await startSite();
    const agent = await site.agent("ada");
    const channel = await site.owner.channel("team");
    await site.owner.post(`/api/chat/conversations/${channel}/invite`, {
      requestId: randomUUID(),
      invitee: agent.accountId,
    });
    await agent.say(channel, "avatar marker");
    await site.owner.post("/api/chat/dms", { requestId: randomUUID(), other: agent.accountId });
    const { page } = await openApp(site, `/app/admin/agents/${agent.agentId}`);
    await page
      .locator('img[src^="https://api.dicebear.com/"]')
      .first()
      .waitFor({ state: "visible" });
    await upload(page, image(red));
    await page.getByText("头像已保存", { exact: true }).waitFor();
    const first = await renderedAvatar(page, agent.accountId);
    await page.goto(`${site.origin}/app/admin/agents`);
    expect(await renderedAvatar(page.locator('[data-agent="ada"]'), agent.accountId)).toBe(first);
    await page.goto(`${site.origin}/app/c/${channel}`);
    expect(
      await renderedAvatar(
        page.getByRole("article").filter({ hasText: "avatar marker" }),
        agent.accountId,
      ),
    ).toBe(first);
    expect(
      await renderedAvatar(page.getByRole("navigation", { name: "会话" }), agent.accountId),
    ).toBe(first);
    await page.goto(`${site.origin}/app/search?q=avatar%20marker`);
    expect(
      await renderedAvatar(
        page.getByRole("listitem").filter({ hasText: "avatar marker" }),
        agent.accountId,
      ),
    ).toBe(first);
    await page.goto(`${site.origin}/app?dm=ada`);
    expect(await renderedAvatar(page.locator("header"), agent.accountId)).toBe(first);
    await page.route(`**${first}`, (route) => route.abort());
    await page.goto(`${site.origin}/app/admin/agents/${agent.agentId}`);
    await page
      .locator('img[src^="https://api.dicebear.com/"]')
      .first()
      .waitFor({ state: "visible" });
    await upload(page, image(blue));
    await page.getByText("头像已保存", { exact: true }).waitFor();
    expect(await renderedAvatar(page, agent.accountId)).not.toBe(first);
  });

  it("keeps the newer avatar when an earlier upload response arrives late", async () => {
    const site = await startSite();
    const { accountId } = await site.owner.get<{ accountId: number }>("/api/me");
    const { page } = await openApp(site, "/app/profile");
    const { page: other } = await openApp(site, "/app/profile");
    const committed = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await page.route("**/api/me/avatar", async (route) => {
      const response = await route.fetch();
      committed.resolve();
      await release.promise;
      await route.fulfill({ response });
    });
    try {
      await page.getByLabel("头像图片").setInputFiles(image(red));
      await committed.promise;
      const original = await renderedAvatar(page, accountId);
      await upload(other, image(blue));
      const latest = await renderedAvatar(other, accountId);
      expect(latest).not.toBe(original);
      await page.locator(`img[src="${latest}"]`).first().waitFor({ state: "visible" });
      release.resolve();
      await page.getByText("头像已保存", { exact: true }).waitFor();
      expect(await renderedAvatar(page, accountId)).toBe(latest);
      await page.reload();
      expect(await renderedAvatar(page, accountId)).toBe(latest);
    } finally {
      release.resolve();
    }
  });

  it("displays JPEG and WebP uploads as square WebP pictures", async () => {
    const site = await startSite();
    const { accountId } = await site.owner.get<{ accountId: number }>("/api/me");
    const { page } = await openApp(site, "/app/profile");
    for (const mimeType of ["image/jpeg", "image/webp"]) {
      const encoded = await page.evaluate((type) => {
        const canvas = document.createElement("canvas");
        canvas.width = 500;
        canvas.height = 300;
        const context = canvas.getContext("2d")!;
        context.fillStyle = type === "image/jpeg" ? "red" : "blue";
        context.fillRect(0, 0, 500, 300);
        return canvas.toDataURL(type).split(",")[1]!;
      }, mimeType);
      await page.getByLabel("头像图片").setInputFiles({
        name: `avatar.${mimeType.split("/")[1]}`,
        mimeType,
        buffer: Buffer.from(encoded, "base64"),
      });
      await page.getByText("头像已保存", { exact: true }).waitFor();
      const source = await renderedAvatar(page, accountId);
      expect(
        await page
          .locator(`img[src="${source}"]`)
          .first()
          .evaluate((element) =>
            element instanceof HTMLImageElement
              ? [element.naturalWidth, element.naturalHeight]
              : [],
          ),
      ).toEqual([256, 256]);
    }
  });

  it("refuses invalid and oversized files inline and leaves the current picture visible", async () => {
    const site = await startSite();
    const { accountId } = await site.owner.get<{ accountId: number }>("/api/me");
    const { page } = await openApp(site, "/app/profile");
    const input = page.getByLabel("头像图片");
    await upload(page, image(red));
    await page.getByText("头像已保存", { exact: true }).waitFor();
    const original = await renderedAvatar(page, accountId);
    await input.setInputFiles({
      name: "vector.svg",
      mimeType: "image/svg+xml",
      buffer: Buffer.from("<svg></svg>"),
    });
    await page.getByText("请选择 PNG、JPEG 或 WebP 图片。", { exact: true }).waitFor();
    await input.setInputFiles({
      name: "broken.png",
      mimeType: "image/png",
      buffer: Buffer.from("not an image"),
    });
    await page
      .getByText("图片无法读取，请选择完整的 PNG、JPEG 或 WebP 图片。", { exact: true })
      .waitFor();
    await input.setInputFiles({
      name: "large.png",
      mimeType: "image/png",
      buffer: Buffer.alloc(5 * 1024 * 1024 + 1),
    });
    await page.getByText("图片不能超过 5 MiB。", { exact: true }).waitFor();
    expect(await renderedAvatar(page, accountId)).toBe(original);
  });
});
