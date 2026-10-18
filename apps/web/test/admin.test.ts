import { ScriptedProvider } from "@mate/testkit";
import { describe, expect, it, onTestFinished } from "vitest";
import { openApp, startSite } from "./support.ts";

const KEY = "sk-test-12345678";

describe("providers and nodes", () => {
  it("the owner saves a provider's API key and sees only its last four characters, then deletes it", async () => {
    const site = await startSite();
    const scripted = await ScriptedProvider.start();
    onTestFinished(() => scripted.close());
    const { page } = await openApp(site, "/app/admin/providers");
    const openai = page.locator('[data-provider="openai"]');
    await openai.getByText("未设置").waitFor();
    await openai.getByLabel("API key").fill(KEY);
    await openai.getByLabel("接口地址（可选）").fill(scripted.baseUrl);
    await openai.getByRole("button", { name: "保存" }).click();
    await openai.getByText("已设置").waitFor();
    const shown = (await openai.textContent()) ?? "";
    expect(shown).toContain("5678");
    expect(shown, "the key is never shown whole").not.toContain(KEY);
    await openai.getByRole("button", { name: "删除 key" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "删除 key" }).click();
    await openai.getByText("未设置").waitFor();
  });

  it("a pairing token is shown once made, and a node that pairs with it appears online", async () => {
    const site = await startSite();
    const { page } = await openApp(site, "/app/admin/nodes");
    await page.getByText("还没有配对的 node。").waitFor();
    await page.getByRole("button", { name: "生成配对令牌" }).click();
    const token = (await page.getByTestId("pairing-token").textContent()) ?? "";
    expect(token.length).toBeGreaterThan(10);
    const nodeId = await site.pairNode();
    await page.locator(`[data-node="${nodeId}"]`).getByText("在线").waitFor();
  });
});

describe("Agents", () => {
  it("the owner creates an Agent from the page, talks to it and watches it work; pausing ends the watch", async () => {
    const site = await startSite();
    const scripted = await site.provider();
    await site.pairNode({
      onBrowse: async (request) => ({
        ok: true,
        listing:
          request.path === "notes.txt"
            ? {
                kind: "file",
                path: "notes.txt",
                size: 11,
                content: "remember me",
                truncated: false,
              }
            : {
                kind: "directory",
                path: ".",
                entries: [
                  { name: "notes.txt", kind: "file", size: 11 },
                  { name: "src", kind: "directory" },
                ],
                truncated: false,
              },
      }),
    });
    const { page } = await openApp(site, "/app/admin/agents");

    await page.getByRole("button", { name: "创建 Agent" }).click();
    const form = page.getByRole("form", { name: "创建 Agent" });
    await form.getByLabel("显示名").fill("Richard");
    await form.getByLabel("Handle").fill("richard");
    await form.getByLabel("模型").selectOption("openai/gpt-4.1");
    await form.getByRole("button", { name: "创建", exact: true }).click();
    const card = page.locator('[data-agent="richard"]');
    await card.getByText("运行中").waitFor();

    await card.getByRole("link", { name: "发消息" }).click();
    await page.waitForURL(/\/app\/c\/\d+/);
    const conversation = Number(/\/app\/c\/(\d+)/.exec(page.url())?.[1]);
    const timeline = { conversation };
    let read: string[] = [];
    scripted
      .step("read", (request) => {
        read = request.call([{ name: "chat_read_unread", arguments: { timeline } }]);
      })
      .step("reply", (request) => {
        expect(request.toolOutput(read[0] ?? "")).toContain("status report");
        request.call([
          { name: "chat_send", arguments: { timeline, body: "All green, nothing to report." } },
        ]);
      })
      .step("done", (request) => request.text("answered"));
    await page.getByLabel("消息", { exact: true }).fill("status report please");
    await page.getByLabel("消息", { exact: true }).press("Enter");
    await page.getByRole("article").filter({ hasText: "All green" }).waitFor();

    await page.goto(`${site.origin}/app/admin/agents`);
    await card.getByRole("link", { name: "Richard" }).click();
    await page.getByRole("tab", { name: "观察" }).click();
    await page.getByTestId("transcript").getByText("status report please").first().waitFor();
    await page.getByTestId("transcript").getByText("All green", { exact: false }).first().waitFor();

    await page.getByRole("tab", { name: "工作区" }).click();
    await page.getByRole("button", { name: /notes\.txt/ }).click();
    await expect.poll(() => page.getByTestId("file-content").textContent()).toBe("remember me");

    await page.getByRole("tab", { name: "观察" }).click();
    await page
      .getByRole("navigation", { name: "面包屑" })
      .getByRole("link", { name: "Agent" })
      .click();
    await card.getByRole("button", { name: "更多" }).click();
    await page.getByRole("menuitem", { name: "暂停" }).click();
    await card.getByText("已暂停").waitFor();
    await card.getByRole("button", { name: "更多" }).click();
    await page.getByRole("menuitem", { name: "恢复" }).click();
    await card.getByText("运行中").waitFor();
    scripted.assertComplete();
  });

  it("the owner changes an Agent's settings and the change is saved", async () => {
    const site = await startSite();
    await site.agent("sam");
    const { page } = await openApp(site, "/app/admin/agents");
    await page.locator('[data-agent="sam"]').getByRole("link", { name: "Sam" }).click();
    const form = page.getByRole("form", { name: "Agent 设置" });
    await form.getByLabel("说明文字（可选）").fill("Be brief.");
    await form.getByRole("button", { name: "保存设置" }).click();
    await page.getByText("已保存").waitFor();
    const agents =
      await site.owner.get<{ handle: string; settings: { instructions?: string } }[]>(
        "/api/admin/agents",
      );
    expect(agents.find((a) => a.handle === "sam")?.settings.instructions).toBe("Be brief.");
  });

  it("deleting an Agent asks for confirmation first and then removes it", async () => {
    const site = await startSite();
    await site.agent("sam");
    const { page } = await openApp(site, "/app/admin/agents");
    const card = page.locator('[data-agent="sam"]');
    const dialog = page.getByRole("alertdialog");
    await card.getByRole("button", { name: "更多" }).click();
    await page.getByRole("menuitem", { name: "删除 Agent" }).click();
    await dialog.getByRole("button", { name: "取消" }).click();
    await dialog.waitFor({ state: "hidden" });
    expect(await card.count(), "cancelled").toBe(1);
    await card.getByRole("button", { name: "更多" }).click();
    await page.getByRole("menuitem", { name: "删除 Agent" }).click();
    await dialog.getByRole("button", { name: "删除", exact: true }).click();
    await page.getByText("还没有 Agent。").waitFor();
  });
});
