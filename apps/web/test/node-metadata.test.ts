import { describe, expect, it } from "vitest";
import { openApp, startSite } from "./support.ts";

const SYSTEM = {
  platform: "linux",
  arch: "arm64",
  hostname: "Build.Server",
  osRelease: "6.8.0-mate",
  version: "v0.1.0-alpha.3",
};

describe("node names and system information", () => {
  it("an admin sees the reported system and can rename the node without changing it", async () => {
    const site = await startSite();
    const nodeId = await site.pairNode({ system: SYSTEM });
    const { page } = await openApp(site, "/app/admin/nodes", { width: 390, height: 844 });
    const row = page.locator(`[data-node="${nodeId}"]`);
    await row.getByText("build-server", { exact: true }).waitFor();
    await row.getByText("在线", { exact: true }).waitFor();
    for (const value of [SYSTEM.arch, SYSTEM.hostname, SYSTEM.version]) {
      await row.getByText(value, { exact: true }).waitFor();
    }
    await row.getByText(`${SYSTEM.platform} · ${SYSTEM.osRelease}`, { exact: true }).waitFor();

    await row.getByRole("button", { name: "改名" }).click();
    const dialog = page.getByRole("dialog", { name: "修改 Node 名字" });
    await dialog.getByLabel("名字", { exact: true }).fill("laptop");
    await dialog.getByRole("button", { name: "保存名字" }).click();
    await dialog.waitFor({ state: "hidden" });
    await row.getByText("laptop", { exact: true }).waitFor();
    await page.reload();
    await row.getByText("laptop", { exact: true }).waitFor();
    const nodes =
      await site.owner.get<{ nodeId: string; name: string; system: unknown }[]>("/api/admin/nodes");
    expect(nodes.find((node) => node.nodeId === nodeId)).toMatchObject({
      name: "laptop",
      system: SYSTEM,
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
  });

  it("invalid names cannot be submitted, occupied names stay beside the field, and cancelling preserves the name", async () => {
    const site = await startSite();
    const nodeId = await site.pairNode({ system: SYSTEM });
    await site.pairNode({ system: { ...SYSTEM, hostname: "laptop" } });
    const legacyId = await site.pairNode();
    const { page } = await openApp(site, "/app/admin/nodes");
    await page.locator(`[data-node="${legacyId}"]`).getByText("尚未收到系统信息。").waitFor();
    const row = page.locator(`[data-node="${nodeId}"]`);
    await row.getByRole("button", { name: "改名" }).click();
    const dialog = page.getByRole("dialog", { name: "修改 Node 名字" });
    const input = dialog.getByLabel("名字", { exact: true });
    await input.fill("Invalid Name");
    await dialog.getByRole("button", { name: "保存名字" }).click();
    expect(await input.evaluate((element: HTMLInputElement) => element.validity.valid)).toBe(false);

    await input.fill("laptop");
    await dialog.getByRole("button", { name: "保存名字" }).click();
    await dialog.getByRole("alert").getByText("这个名字已被其他 node 使用。").waitFor();
    await dialog.getByRole("button", { name: "取消" }).click();
    await dialog.waitFor({ state: "hidden" });
    await row.getByText("build-server", { exact: true }).waitFor();
  });

  it("creating an Agent selects a node by name, and renaming updates the cached Agent list", async () => {
    const site = await startSite();
    await site.provider();
    await site.pairNode({ system: SYSTEM });
    const nodeId = await site.pairNode({ system: { ...SYSTEM, hostname: "laptop" } });
    const { page } = await openApp(site, "/app/admin/agents");
    await page.getByRole("button", { name: "创建 Agent" }).click();
    const form = page.getByRole("form", { name: "创建 Agent" });
    await form.getByLabel("显示名").fill("Sam");
    await form.getByLabel("Handle").fill("sam");
    await form.getByLabel("Node").selectOption({ label: "laptop（在线）" });
    await form.getByLabel("模型").selectOption("openai/gpt-4.1");
    await form.getByRole("button", { name: "创建", exact: true }).click();
    const card = page.locator('[data-agent="sam"]');
    await card.getByText("Node laptop", { exact: false }).waitFor();
    const agents = await site.owner.get<{ handle: string; nodeId: string }[]>("/api/admin/agents");
    expect(agents.find((agent) => agent.handle === "sam")?.nodeId).toBe(nodeId);

    await page.getByRole("link", { name: "Node", exact: true }).click();
    await page.locator(`[data-node="${nodeId}"]`).getByRole("button", { name: "改名" }).click();
    const dialog = page.getByRole("dialog", { name: "修改 Node 名字" });
    await dialog.getByLabel("名字", { exact: true }).fill("workstation");
    await dialog.getByRole("button", { name: "保存名字" }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByRole("link", { name: "Agent", exact: true }).click();
    await card.getByText("Node workstation", { exact: false }).waitFor();
    await page.getByRole("button", { name: "创建 Agent" }).click();
    const options = await form.getByLabel("Node").locator("option").allTextContents();
    expect(options).toContain("workstation（在线）");
    expect(options).not.toContain("laptop（在线）");
  });
});
