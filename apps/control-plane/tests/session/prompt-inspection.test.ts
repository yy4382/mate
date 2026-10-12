import { expect, it } from "vitest";
import { buildAgentSystemPrompt, inspectPrompts } from "../../src/prompts/index.js";

it("inspects ordered system sections while withholding all content by default", () => {
  const built = buildAgentSystemPrompt({
    name: "private name",
    role: "private role",
    description: "private description\nsecond line",
  });
  expect(built.systemPrompt).toBe(built.sections.map((section) => section.text).join("\n"));
  expect(built.sections.map((section) => section.id)).toEqual([
    "identity",
    "role",
    "description",
    "continuity",
    "tasks",
    "persistence",
    "workspace",
    "attention",
    "routing",
    "tools",
  ]);
  const diagnostic = inspectPrompts();
  expect(diagnostic.systemSections.map((section) => section.id)).toEqual(
    built.sections.map((section) => section.id),
  );
  for (const section of diagnostic.systemSections) {
    expect(section).toHaveProperty("source");
    expect(section).toHaveProperty("condition");
    expect(section).not.toHaveProperty("text");
  }
  expect(diagnostic).not.toHaveProperty("systemPrompt");
  expect(inspectPrompts({ showContent: true }).systemPrompt).toContain(
    "你是 Mate 中的 Agent 同事「示例同事」。",
  );
});

it("inspects native system changes without leaking fields or pretending they are complete prompts", async () => {
  const { inspectSystemEntry } = await import("../../src/prompts/inspection.js");
  const entry = {
    kind: "pi.system",
    model: [
      {
        role: "system",
        content: "",
        sections: { instructions: "private prompt" },
        toolsAdded: [{ name: "private-tool" }],
        apiKey: "secret",
      },
    ],
    apiKey: "outer secret",
  };
  expect(inspectSystemEntry(entry)).toEqual({
    kind: "saved-system-entry",
    provenance: "native-positional-change",
    sectionCount: 1,
    toolsAddedCount: 1,
    toolsRemovedCount: 0,
  });
  expect(JSON.stringify(inspectSystemEntry(entry, { showContent: true }))).toContain(
    "private prompt",
  );
  expect(JSON.stringify(inspectSystemEntry(entry, { showContent: true }))).not.toContain("secret");
  expect(() =>
    inspectSystemEntry({ kind: "configuration", configuration: { systemPrompt: "old" } }),
  ).toThrow("Invalid Durable system entry");
});

it("keeps the command's normal output and failures free of private input", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const directory = mkdtempSync(join(tmpdir(), "mate-prompt-inspect-"));
  const file = join(directory, "private-filename-secret.json");
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["dist/prompts/inspect.js", ...args], { encoding: "utf8" });
  try {
    const entry = {
      kind: "pi.system",
      model: [
        {
          role: "system",
          content: "",
          sections: { instructions: "private prompt" },
          toolsAdded: [],
        },
      ],
      apiKey: "secret key",
    };
    writeFileSync(file, JSON.stringify(entry));
    const normal = run();
    expect(normal.status).toBe(0);
    expect(JSON.parse(normal.stdout)).not.toHaveProperty("systemPrompt");
    const hidden = run("--entry", file);
    expect(hidden.status).toBe(0);
    expect(hidden.stdout + hidden.stderr).not.toMatch(/private|secret/);
    const visible = run("--entry", file, "--show-content");
    expect(visible.status).toBe(0);
    expect(JSON.parse(visible.stdout).message.sections.instructions).toBe("private prompt");
    expect(visible.stdout).not.toContain("secret key");
    writeFileSync(file, '{"private invalid JSON secret');
    for (const args of [
      ["--entry", file],
      ["--entry", file + "missing"],
      ["--unknown-private-secret"],
      ["--entry"],
    ]) {
      const result = run(...args);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toMatch(/private|secret/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("inspects the adopted native model, prompt, tools and versions against real provider requests", async () => {
  const { loopFixture, respond } = await import("../support/agent/agent-loop.js");
  const { spawnSync } = await import("node:child_process");
  const { join } = await import("node:path");
  const fixture = await loopFixture((_request, response) =>
    respond(response, "private assistant text"),
  );
  try {
    const agent = await fixture.agent("private profile name");
    const file = join(fixture.directory, "control-plane-data", "durable", `${agent.id}.sqlite`);
    const inspect = (expanded = false) => {
      const result = spawnSync(
        process.execPath,
        ["dist/prompts/inspect.js", "--session", file, ...(expanded ? ["--show-content"] : [])],
        { encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout + result.stderr).not.toContain("synthetic-control-only-key");
      expect(result.stdout + result.stderr).not.toContain("private assistant text");
      return JSON.parse(result.stdout);
    };
    await fixture.send(agent.channelId, "Inspect adopted configuration");
    await fixture.completed(agent.id);
    const safe = inspect();
    expect(safe).toMatchObject({
      kind: "saved-session-configuration",
      model: { provider: "openai", modelId: "gpt-4o-mini" },
      runtimeVersions: { piDurable: "1.1.0", piAi: "1.1.0" },
      toolCount: 3,
    });
    expect(JSON.stringify(safe)).not.toContain("private profile name");
    expect(safe).not.toHaveProperty("systemPrompt");
    expect(safe).not.toHaveProperty("tools");
    const expanded = inspect(true);
    expect(fixture.requests[0]!.input[0].content).toBe(expanded.systemPrompt);
    const requestedTools = fixture.requests[0]!.tools;
    if (!requestedTools) throw new Error("Actual provider request omitted tool definitions");
    expect(
      requestedTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    ).toEqual(expanded.tools);
    await fixture.api(`/api/owner/agents/${agent.id}/model`, "PUT", {
      provider: "openai",
      id: "gpt-4o",
    });
    await fixture.api(`/api/owner/agents/${agent.id}/profile`, "PATCH", {
      name: "changed private profile",
    });
    await fixture.send(agent.channelId, "Inspect changed native configuration");
    await expect.poll(() => fixture.requests.length, { timeout: 15000 }).toBe(2);
    await fixture.completed(agent.id);
    const changed = inspect(true);
    expect(changed.model).toEqual({ provider: "openai", modelId: "gpt-4o" });
    expect(fixture.requests[1]!.input[0].content).toBe(changed.systemPrompt);
    expect(changed.systemPrompt).toContain("changed private profile");
    await fixture.restartControl();
    expect(inspect(true)).toEqual(changed);
  } finally {
    await fixture.close();
  }
}, 30000);
