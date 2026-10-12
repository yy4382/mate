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
