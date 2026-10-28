import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  connectedNode,
  eventually,
  longCommand,
  pidsOf,
  running,
  scriptCommand,
  temporaryDirectory,
  textOf,
  windows,
} from "./support.ts";

describe("node visits (MODULE_TESTS 8)", () => {
  it("prepares an Agent workspace and uses its actual directory and platform HOME for visits", async () => {
    const node = await connectedNode();
    const agentId = `visitor-${randomUUID()}`;
    const workspace = join(node.workspacesRoot, agentId);
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
    expect(realpathSync.native(cwd!)).toBe(realpathSync.native(workspace));
    expect(home).toBe(windows ? workspace : node.home);
    expect(realpathSync.native(shellHome!)).toBe(realpathSync.native(workspace));
    expect(chunks.join("")).toContain(workspace);
    expect(existsSync(workspace)).toBe(true);
    expect(existsSync(join(workspace, "MEMORY.md"))).toBe(false);
    expect(existsSync(join(node.home, "MEMORY.md"))).toBe(false);
  });

  it("uses the same workspace for bash, write, edit and read and refuses outside file paths", async () => {
    const node = await connectedNode();
    const agentId = `visitor-${randomUUID()}`;
    const workspace = join(node.workspacesRoot, agentId);
    const path = join(workspace, "notes", "today.md");
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
    const command = await node.run(
      agentId,
      "bash",
      { command: windows ? "Get-Content -Raw notes/today.md" : "cat notes/today.md" },
      undefined,
      "visit",
    );
    expect(command.isError, textOf(command)).toBe(false);
    expect(textOf(command).trim()).toBe("first\nupdated");

    const outside = temporaryDirectory();
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "secret");
    const refused = await node.run(
      agentId,
      "write",
      { path: secret, content: "overwritten" },
      undefined,
      "visit",
    );
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("is outside the workspace");
    expect(readFileSync(secret, "utf8")).toBe("secret");
    expect(existsSync(workspace)).toBe(true);
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
    const visitedPids = await pidsOf(workspace, "visit");
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

  it("keeps each Agent's files separate through repeated preparation and reconnection", async () => {
    const node = await connectedNode();
    const agents = ["visitor-one", "visitor-two"];
    for (const agentId of agents) {
      const result = await node.run(
        agentId,
        "write",
        { path: "MEMORY.md", content: agentId },
        undefined,
        "visit",
      );
      expect(result.isError, textOf(result)).toBe(false);
      expect(
        (
          await node.run(
            agentId,
            "write",
            { path: "notes.txt", content: agentId },
            undefined,
            "visit",
          )
        ).isError,
      ).toBe(false);
    }
    const preparations = await Promise.all(
      agents.flatMap((agentId) => [
        node.gateway.prepareWorkspace(randomUUID(), agentId, "visit"),
        node.gateway.prepareWorkspace(randomUUID(), agentId, "visit"),
      ]),
    );
    for (const result of preparations) expect(result.isError, textOf(result)).toBe(false);
    const before = node.gateway.authentications;
    node.gateway.disconnect();
    await eventually(() => node.gateway.authentications > before, "node reconnected");
    for (const agentId of agents) {
      for (const path of ["MEMORY.md", "notes.txt"]) {
        const result = await node.run(agentId, "read", { path }, undefined, "visit");
        expect(result.isError, textOf(result)).toBe(false);
        expect(textOf(result)).toBe(agentId);
      }
    }
  });

  it("prepares visits without initializing MEMORY.md and preserves user-created files", async () => {
    const node = await connectedNode();
    const agentId = "visitor";
    const workspace = join(node.workspacesRoot, agentId);
    expect((await node.gateway.prepareWorkspace(randomUUID(), agentId, "visit")).isError).toBe(
      false,
    );
    expect(existsSync(workspace)).toBe(true);
    expect(existsSync(join(workspace, "MEMORY.md"))).toBe(false);
    writeFileSync(join(workspace, "MEMORY.md"), "user-created");
    expect((await node.gateway.prepareWorkspace(randomUUID(), agentId, "visit")).isError).toBe(
      false,
    );
    expect(readFileSync(join(workspace, "MEMORY.md"), "utf8")).toBe("user-created");
    rmSync(join(workspace, "MEMORY.md"));
    expect((await node.gateway.prepareWorkspace(randomUUID(), agentId, "visit")).isError).toBe(
      false,
    );
    expect(
      (await node.run(agentId, "bash", { command: "echo ready" }, undefined, "visit")).isError,
    ).toBe(false);
    expect(existsSync(workspace)).toBe(true);
    expect(existsSync(join(workspace, "MEMORY.md"))).toBe(false);
  });

  it("refuses visits when the workspace path is a file and retries after its removal", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    rmSync(workspace, { recursive: true });
    writeFileSync(workspace, "not a directory");
    const outside = temporaryDirectory();
    const marker = join(outside, "executed.txt");
    const command = scriptCommand(
      outside,
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "executed");`,
    );
    const refused = await node.run(agentId, "bash", { command }, undefined, "visit");
    expect(refused.isError).toBe(true);
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(workspace, "utf8")).toBe("not a directory");
    rmSync(workspace);
    const retried = await node.run(agentId, "bash", { command }, undefined, "visit");
    expect(retried.isError, textOf(retried)).toBe(false);
    expect(readFileSync(marker, "utf8")).toBe("executed");
    expect(existsSync(join(workspace, "MEMORY.md"))).toBe(false);
  });

  it.runIf(windows)(
    "sets Windows HOME and PowerShell HOME to the workspace when the node has no HOME",
    async () => {
      const node = await connectedNode({ env: { HOME: undefined } });
      const workspace = join(node.workspacesRoot, "visitor");
      const result = await node.run(
        "visitor",
        "bash",
        { command: "(Get-Location).Path; Test-Path Env:HOME; $HOME" },
        undefined,
        "visit",
      );
      expect(result.isError, textOf(result)).toBe(false);
      const [cwd, ...environment] = textOf(result).split(/\r?\n/).slice(0, 3);
      expect(realpathSync.native(cwd!)).toBe(realpathSync.native(workspace));
      expect(environment).toEqual(["True", workspace]);
      expect(existsSync(workspace)).toBe(true);
    },
  );
});
