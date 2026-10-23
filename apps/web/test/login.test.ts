import { describe, expect, it } from "vitest";
import { PASSWORD, newPage, startSite } from "./support.ts";

describe("the login page", () => {
  it("a wrong handle or password is refused with a message and the right one opens the app", async () => {
    const site = await startSite();
    const { page } = await newPage(site);
    await page.goto(`${site.origin}/app`);
    expect(page.url(), "a page behind login sends the visitor to log in").toContain(
      "/login?next=%2Fapp",
    );
    await page.getByLabel("Handle").fill("admin");
    await page.getByLabel("密码").fill("not the password");
    await page.getByRole("button", { name: "登录" }).click();
    await expect.poll(() => page.getByRole("alert").textContent()).toBe("Handle 或密码不对。");
    await page.getByLabel("密码").fill(PASSWORD);
    await page.getByRole("button", { name: "登录" }).click();
    await page.waitForURL(`${site.origin}/app`);
    await page.getByRole("navigation", { name: "会话" }).waitFor();
  });
});
