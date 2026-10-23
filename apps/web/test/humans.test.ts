import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PASSWORD, newPage, openApp, signIn, startSite, type Site } from "./support.ts";

const MEMBER_PASSWORD = "member password 123";

async function addMember(site: Site, handle: string, displayName: string) {
  await site.owner.post("/api/humans", {
    requestId: randomUUID(),
    handle,
    displayName,
    password: MEMBER_PASSWORD,
    role: "member",
  });
}

describe("humans", () => {
  it("an admin adds a member on the humans page, who logs in, chats, and sees no admin pages", async () => {
    const site = await startSite();
    const { page: admin } = await openApp(site, "/app/admin/humans");
    await admin.getByRole("button", { name: "添加人类" }).first().click();
    const form = admin.getByRole("form", { name: "添加人类" });
    await form.getByLabel("显示名").fill("Mei");
    await form.getByLabel("Handle").fill("mei");
    await form.getByLabel("初始密码").fill(MEMBER_PASSWORD);
    await form.getByRole("button", { name: "添加", exact: true }).click();
    const row = admin.locator('[data-human="mei"]');
    await row.getByText("普通人类").waitFor();
    await admin.locator('[data-human="admin"]').getByText("你").waitFor();

    const { page: member } = await openApp(site, "/app", undefined, {
      handle: "mei",
      password: MEMBER_PASSWORD,
    });
    const nav = member.getByRole("navigation", { name: "主导航" });
    await member.getByRole("button", { name: "Mei" }).waitFor();
    await member.getByRole("navigation", { name: "会话" }).waitFor();
    expect(await nav.getByRole("link", { name: "管理" }).count(), "no admin navigation").toBe(0);

    await member.goto(`${site.origin}/app/admin/agents`);
    await member.getByText("需要管理员权限").waitFor();
    expect(await member.getByRole("button", { name: "创建 Agent" }).count()).toBe(0);
  });

  it("a human edits their name and handle, sees the new name in the navigation, and logs in with the new handle", async () => {
    const site = await startSite();
    await addMember(site, "mei", "Mei");
    const { page } = await openApp(site, "/app/profile");
    const form = page.getByRole("form", { name: "基本信息" });
    await form.getByLabel("Handle").fill("mei");
    await form.getByRole("button", { name: "保存" }).click();
    await form.getByText("这个 handle 已被占用。").waitFor();

    await form.getByLabel("显示名").fill("Ada Lovelace");
    await form.getByLabel("Handle").fill("ada");
    await form.getByRole("button", { name: "保存" }).click();
    await form.getByText("已保存").waitFor();
    await page.getByRole("button", { name: "Ada Lovelace" }).waitFor();

    const { page: again } = await newPage(site);
    await signIn(again, site, "/app/profile", { handle: "ada", password: PASSWORD });
    await again.getByLabel("Handle").waitFor();
    expect(await again.getByLabel("Handle").inputValue()).toBe("ada");
  });

  it("changing the password shows a wrong current password inline, and a correct change keeps this session working", async () => {
    const site = await startSite();
    const { page } = await openApp(site, "/app/profile");
    const form = page.getByRole("form", { name: "修改密码" });
    const submit = form.getByRole("button", { name: "修改密码" });
    await form.getByLabel("当前密码").fill("not the password");
    await form.getByLabel("新密码", { exact: true }).fill("a brand new password");
    await form.getByLabel("确认新密码").fill("a brand new password");
    await submit.click();
    await form.getByText("当前密码不对。").waitFor();

    await form.getByLabel("当前密码").fill(PASSWORD);
    await form.getByLabel("新密码", { exact: true }).fill("short");
    await form.getByLabel("确认新密码").fill("short");
    await submit.click();
    await form.getByText("新密码至少 12 个字节。").waitFor();

    await form.getByLabel("新密码", { exact: true }).fill("a brand new password");
    await form.getByLabel("确认新密码").fill("a brand new password");
    await submit.click();
    await form.getByText("已保存").waitFor();
    await page.reload();
    await page.getByRole("heading", { name: "个人资料" }).waitFor();

    const { page: again } = await newPage(site);
    await signIn(again, site, undefined, { handle: "admin", password: "a brand new password" });
  });

  it("the last admin cannot be demoted, and deactivating a human asks first and then marks the row", async () => {
    const site = await startSite();
    await addMember(site, "mei", "Mei");
    const { page } = await openApp(site, "/app/admin/humans");
    await page.getByRole("button", { name: "更多：admin" }).click();
    await page.getByRole("menuitem", { name: "设为普通人类" }).click();
    await page.getByText("必须至少保留一个有效的管理员。").waitFor();
    await page.locator('[data-human="admin"]').getByText("管理员").waitFor();

    const row = page.locator('[data-human="mei"]');
    const dialog = page.getByRole("alertdialog");
    await row.getByRole("button", { name: "更多：Mei" }).click();
    await page.getByRole("menuitem", { name: "停用" }).click();
    await dialog.getByRole("button", { name: "取消" }).click();
    await dialog.waitFor({ state: "hidden" });
    expect(await row.getByText("已停用").count(), "cancelled").toBe(0);
    await row.getByRole("button", { name: "更多：Mei" }).click();
    await page.getByRole("menuitem", { name: "停用" }).click();
    await dialog.getByRole("button", { name: "停用", exact: true }).click();
    await row.getByText("已停用").waitFor();
  });
});
