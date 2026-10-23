import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { connectedNode, temporaryDirectory, textOf, windows } from "./support.ts";

function shortPath(path: string): string {
  return execFileSync(
    "cmd.exe",
    ["/d", "/c", 'for %I in ("%MATE_TEST_DIRECTORY%") do @echo %~sI'],
    {
      env: { ...process.env, MATE_TEST_DIRECTORY: path },
      encoding: "utf8",
    },
  ).trim();
}

describe.runIf(windows)("Windows workspace path aliases through the node protocol", () => {
  it("reads, writes, edits and browses the same directory through its short and long names", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    const long = realpathSync.native(workspace);
    const short = shortPath(long);
    expect(short.toLowerCase(), "this filesystem exposes a distinct Windows short name").not.toBe(
      long.toLowerCase(),
    );

    const written = await node.run(agentId, "write", {
      path: join(short.toUpperCase(), "new", "notes.txt"),
      content: "first",
    });
    expect(written.isError, textOf(written)).toBe(false);
    const edited = await node.run(agentId, "edit", {
      path: join(long, "new", "notes.txt"),
      edits: [{ oldText: "first", newText: "second" }],
    });
    expect(edited.isError, textOf(edited)).toBe(false);

    for (const base of [short, long]) {
      const read = await node.run(agentId, "read", { path: join(base, "new", "notes.txt") });
      expect(read.isError, textOf(read)).toBe(false);
      expect(textOf(read)).toBe("second");
      expect(await node.gateway.browse(randomUUID(), agentId, join(base, "new"))).toEqual({
        ok: true,
        listing: {
          kind: "directory",
          path: "new",
          entries: [{ name: "notes.txt", kind: "file", size: 6 }],
          truncated: false,
        },
      });
    }
    expect(readFileSync(join(workspace, "new", "notes.txt"), "utf8")).toBe("second");
  });

  it("still refuses outside aliases and any junction in the supplied path, even when it points inward", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    const outside = temporaryDirectory();
    mkdirSync(join(workspace, "inside"));
    writeFileSync(join(workspace, "inside", "notes.txt"), "inside");
    writeFileSync(join(outside, "notes.txt"), "outside");
    symlinkSync(outside, join(workspace, "outward"), "junction");
    symlinkSync(join(workspace, "inside"), join(workspace, "inward"), "junction");
    symlinkSync(workspace, join(outside, "workspace-alias"), "junction");

    for (const path of [
      join(shortPath(outside), "notes.txt"),
      join(realpathSync.native(outside), "new", "notes.txt"),
      join(workspace, "outward", "notes.txt"),
      join(workspace, "inward", "notes.txt"),
      join(outside, "workspace-alias", "inside", "notes.txt"),
    ]) {
      const read = await node.run(agentId, "read", { path });
      expect(read.isError, path).toBe(true);
      expect(textOf(read), path).toContain("is outside the workspace");
      const written = await node.run(agentId, "write", { path, content: "overwritten" });
      expect(written.isError, path).toBe(true);
      expect(textOf(written), path).toContain("is outside the workspace");
      expect(await node.gateway.browse(randomUUID(), agentId, path), path).toMatchObject({
        ok: false,
        reason: "outside-workspace",
      });
    }
    expect(readFileSync(join(workspace, "inside", "notes.txt"), "utf8")).toBe("inside");
    expect(readFileSync(join(outside, "notes.txt"), "utf8")).toBe("outside");
    expect(existsSync(join(outside, "new"))).toBe(false);
  });
});
