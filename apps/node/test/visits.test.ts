import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonValue, ToolName } from "@mate/node-protocol";
import { describe, expect, it } from "vitest";
import {
  connectedNode,
  eventually,
  longCommand,
  pidsOf,
  running,
  temporaryDirectory,
  textOf,
  windows,
} from "./support.ts";

describe("node visits (MODULE_TESTS 8)", () => {
  it("visits the node account's home without preparing an Agent workspace or MEMORY.md", async () => {
    const node = await connectedNode();
    const agentId = `visitor-${randomUUID()}`;
    const chunks: string[] = [];
    const result = await node.run(
      agentId,
      "bash",
      {
        command: windows
          ? "(Get-Location).Path; $env:HOME; $HOME"
          : 'printf "%s\\n" "$PWD" "$HOME" "$(pwd -P)"',
      },
      (chunk) => chunks.push(chunk),
      "visit",
    );
    expect(result.isError, textOf(result)).toBe(false);
    const [cwd, home, shellHome] = textOf(result).split(/\r?\n/);
    expect(realpathSync.native(cwd!)).toBe(realpathSync.native(node.home));
    expect(home).toBe(node.home);
    expect(realpathSync.native(shellHome!)).toBe(realpathSync.native(node.home));
    expect(chunks.join("")).toContain(node.home);
    expect(existsSync(node.workspacesRoot)).toBe(false);
    expect(existsSync(join(node.home, "MEMORY.md"))).toBe(false);

    const homeCall = await node.run(agentId, "bash", { command: "echo not-prepared" });
    expect(homeCall.isError).toBe(true);
    expect(textOf(homeCall)).toContain("does not exist. The node does not recreate it");
    expect(existsSync(node.workspacesRoot)).toBe(false);
  });

  it("writes, edits and reads inside the visited home and refuses every path outside it", async () => {
    const node = await connectedNode();
    const agentId = `visitor-${randomUUID()}`;
    const path = join(node.home, "notes", "today.md");
    const written = await node.run(
      agentId,
      "write",
      { path, content: "first\nsecond\n" },
      undefined,
      "visit",
    );
    expect(written.isError, textOf(written)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("first\nsecond\n");

    const edited = await node.run(
      agentId,
      "edit",
      { path: "notes/today.md", edits: [{ oldText: "second", newText: "updated" }] },
      undefined,
      "visit",
    );
    expect(edited.isError, textOf(edited)).toBe(false);
    const read = await node.run(agentId, "read", { path }, undefined, "visit");
    expect(read.isError, textOf(read)).toBe(false);
    expect(textOf(read)).toBe("first\nupdated\n");

    const outside = temporaryDirectory();
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "secret");
    symlinkSync(outside, join(node.home, "outside"), windows ? "junction" : "dir");
    const escaped = `escaped-${randomUUID()}.txt`;
    for (const path of [`../${escaped}`, secret, "outside/secret.txt"]) {
      for (const [tool, args] of [
        ["read", { path }],
        ["write", { path, content: "overwritten" }],
        ["edit", { path, edits: [{ oldText: "secret", newText: "overwritten" }] }],
      ] satisfies [ToolName, Record<string, JsonValue>][]) {
        const result = await node.run(agentId, tool, args, undefined, "visit");
        expect(result.isError, `${tool} ${path}`).toBe(true);
        expect(textOf(result), `${tool} ${path}`).toContain("is outside the workspace");
      }
    }
    expect(readFileSync(secret, "utf8")).toBe("secret");
    expect(existsSync(join(node.home, "..", escaped))).toBe(false);
    expect(existsSync(node.workspacesRoot)).toBe(false);
    expect(existsSync(join(node.home, "MEMORY.md"))).toBe(false);
  });

  it("stops a visited command's process tree while a home command keeps running", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    const visited = node.gateway.runTool(
      "visit-to-stop",
      agentId,
      "bash",
      { command: longCommand("visit") },
      undefined,
      "visit",
    );
    const home = node.run(agentId, "bash", { command: longCommand("home") });
    const visitedPids = await pidsOf(node.home, "visit");
    const homePids = await pidsOf(workspace, "home");
    expect([...visitedPids, ...homePids].every(running)).toBe(true);

    node.gateway.stopTool("visit-to-stop");
    const result = await visited;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Command was stopped");
    for (const pid of visitedPids)
      await eventually(() => !running(pid), `visited process ${pid} stopped`);
    expect(homePids.every(running)).toBe(true);
    writeFileSync(join(workspace, "home.go"), "");
    expect((await home).isError).toBe(false);
  });

  it.runIf(windows).each(["HOME", "Home"])(
    "preserves the node's %s value during a Windows visit whose directory is USERPROFILE",
    async (key) => {
      const originalHome = join(temporaryDirectory(), "separate-home");
      const node = await connectedNode({ env: { [key]: originalHome } });
      const result = await node.run(
        "visitor",
        "bash",
        { command: "(Get-Location).Path; $env:USERPROFILE; $env:HOME; $HOME" },
        undefined,
        "visit",
      );
      expect(result.isError, textOf(result)).toBe(false);
      const [cwd, ...environment] = textOf(result).split(/\r?\n/).slice(0, 4);
      expect(realpathSync.native(cwd!)).toBe(realpathSync.native(node.home));
      expect(environment).toEqual([node.home, originalHome, originalHome]);
      expect(existsSync(originalHome)).toBe(false);
      expect(existsSync(node.workspacesRoot)).toBe(false);
    },
  );

  it.runIf(windows)(
    "leaves a missing Windows HOME absent and keeps PowerShell's automatic HOME",
    async () => {
      const node = await connectedNode({ env: { HOME: undefined } });
      const result = await node.run(
        "visitor",
        "bash",
        { command: "(Get-Location).Path; Test-Path Env:HOME; $HOME" },
        undefined,
        "visit",
      );
      expect(result.isError, textOf(result)).toBe(false);
      const [cwd, ...environment] = textOf(result).split(/\r?\n/).slice(0, 3);
      expect(realpathSync.native(cwd!)).toBe(realpathSync.native(node.home));
      expect(environment).toEqual(["False", node.home]);
      expect(existsSync(node.workspacesRoot)).toBe(false);
    },
  );

  it.runIf(windows)(
    "replaces a differently cased HOME for home access without changing visit access",
    async () => {
      const originalHome = join(temporaryDirectory(), "separate-home");
      const node = await connectedNode({ env: { Home: originalHome, Pwd: originalHome } });
      const { agentId, workspace } = await node.agent();
      const command = "(Get-Location).Path; $env:HOME; $HOME; $env:PWD";
      const home = await node.run(agentId, "bash", { command });
      expect(home.isError, textOf(home)).toBe(false);
      const [homeCwd, ...homeEnvironment] = textOf(home).split(/\r?\n/).slice(0, 4);
      expect(realpathSync.native(homeCwd!)).toBe(realpathSync.native(workspace));
      expect(homeEnvironment).toEqual([workspace, workspace, workspace]);
      const visit = await node.run(agentId, "bash", { command }, undefined, "visit");
      expect(visit.isError, textOf(visit)).toBe(false);
      const [visitCwd, ...visitEnvironment] = textOf(visit).split(/\r?\n/).slice(0, 4);
      expect(realpathSync.native(visitCwd!)).toBe(realpathSync.native(node.home));
      expect(visitEnvironment).toEqual([originalHome, originalHome, node.home]);
    },
  );
});
