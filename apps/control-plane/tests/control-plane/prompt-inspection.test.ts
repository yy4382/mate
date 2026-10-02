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

it("reuses configuration snapshots without leaking fields or inventing historical provenance", async () => {
  const { inspectConfigurationSnapshot } = await import("../../src/prompts/inspection.js");
  const snapshot = {
    kind: "configuration",
    id: "ignored",
    apiKey: "outer secret",
    configuration: {
      provider: "private provider",
      modelId: "private model",
      systemPrompt: "private saved prompt\noriginal order",
      tools: [{ name: "private tool", parameters: { const: "private parameter" } }],
      piAgentVersion: "0.86.0",
      piAiVersion: "0.86.0",
      formatVersion: 1,
      apiKey: "nested secret",
    },
    transcript: "private transcript",
  };
  const hidden = inspectConfigurationSnapshot(snapshot);
  expect(JSON.stringify(hidden)).not.toMatch(/private|secret/);
  expect(hidden).toMatchObject({
    kind: "saved-configuration",
    provenance: "unavailable-in-snapshot",
    toolCount: 1,
  });
  const visible = inspectConfigurationSnapshot(snapshot, { showContent: true });
  expect(visible.systemPrompt).toBe(snapshot.configuration.systemPrompt);
  expect(visible.tools).toEqual(snapshot.configuration.tools);
  expect(JSON.stringify(visible)).not.toMatch(/secret|transcript|private provider|private model/);
  expect(() => inspectConfigurationSnapshot({ apiKey: "error secret", systemPrompt: 7 })).toThrow(
    "Invalid configuration snapshot",
  );
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
    const snapshot = {
      provider: "synthetic",
      modelId: "synthetic",
      systemPrompt: "private prompt",
      tools: [{ secret: "private schema" }],
      piAgentVersion: "0.86.0",
      piAiVersion: "0.86.0",
      formatVersion: 1,
      apiKey: "secret key",
    };
    writeFileSync(file, JSON.stringify(snapshot));
    const normal = run();
    expect(normal.status).toBe(0);
    expect(JSON.parse(normal.stdout)).not.toHaveProperty("systemPrompt");
    const hidden = run("--snapshot", file);
    expect(hidden.status).toBe(0);
    expect(hidden.stdout + hidden.stderr).not.toMatch(/private|secret/);
    const visible = run("--snapshot", file, "--show-content");
    expect(visible.status).toBe(0);
    expect(JSON.parse(visible.stdout).systemPrompt).toBe(snapshot.systemPrompt);
    expect(visible.stdout).not.toContain("secret key");
    writeFileSync(file, '{"private invalid JSON secret');
    for (const args of [
      ["--snapshot", file],
      ["--snapshot", file + "missing"],
      ["--unknown-private-secret"],
      ["--snapshot"],
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
