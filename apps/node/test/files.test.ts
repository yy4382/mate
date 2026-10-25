import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, parse } from "node:path";
import { onTestFinished, describe, expect, it } from "vitest";
import { connectedNode, temporaryDirectory, textOf, windows } from "./support.ts";

function shortPath(path: string): string {
  const result = spawnSync(
    "cmd.exe",
    ["/d", "/c", 'for %I in ("%MATE_TEST_DIRECTORY%") do @echo %~sI'],
    {
      env: { ...process.env, MATE_TEST_DIRECTORY: path },
      encoding: "utf8",
      windowsVerbatimArguments: true,
    },
  );
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

describe("node file tools (MODULE_TESTS 8.2)", () => {
  it("writes, edits, and reads files the way Durable's local tools do", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();

    const written = await node.run(agentId, "write", {
      path: "notes/today.md",
      content: "one\ntwo\nthree\n",
    });
    expect(textOf(written)).toBe("Successfully wrote to notes/today.md");
    expect(
      readFileSync(join(workspace, "notes/today.md"), "utf8"),
      "parent directories are created",
    ).toBe("one\ntwo\nthree\n");

    const edited = await node.run(agentId, "edit", {
      path: "notes/today.md",
      edits: [{ oldText: "two", newText: "TWO" }],
    });
    expect(edited.isError, textOf(edited)).toBe(false);
    expect(textOf(edited)).toBe("Successfully replaced 1 block(s) in notes/today.md.");
    expect(readFileSync(join(workspace, "notes/today.md"), "utf8")).toBe("one\nTWO\nthree\n");

    const ambiguous = await node.run(agentId, "edit", {
      path: "notes/today.md",
      edits: [{ oldText: "e", newText: "E" }],
    });
    expect(ambiguous.isError, "an oldText that is not unique is refused").toBe(true);
    expect(readFileSync(join(workspace, "notes/today.md"), "utf8")).toBe("one\nTWO\nthree\n");

    const read = await node.run(agentId, "read", { path: "notes/today.md", offset: 2, limit: 1 });
    expect(read.isError).toBe(false);
    expect(textOf(read), "offset and limit select lines, with a continuation remark").toMatch(
      /^TWO\n\[info\] .*offset=3/,
    );

    const missing = await node.run(agentId, "read", { path: "absent.txt" });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toMatch(/absent\.txt/);

    const invalid = await node.run(agentId, "write", { path: "x.txt" });
    expect(invalid.isError, "arguments are validated against Durable's schema").toBe(true);
  });

  it("refuses paths that leave the workspace through .., an absolute path, or a symbolic link", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    const outside = temporaryDirectory();
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(outside, join(workspace, "link"), windows ? "junction" : "dir");
    const escapes = ["../escaped.txt", join(outside, "secret.txt"), "link/secret.txt"];
    if (!windows) {
      symlinkSync(join(outside, "secret.txt"), join(workspace, "secret-link.txt"));
      symlinkSync(join(outside, "not-yet.txt"), join(workspace, "dangling.txt"));
      escapes.push("secret-link.txt", "dangling.txt");
    }

    for (const path of escapes) {
      const read = await node.run(agentId, "read", { path });
      expect(read.isError, `read ${path}`).toBe(true);
      expect(textOf(read), `read ${path}`).toContain("is outside the workspace");
      expect(textOf(read)).not.toContain("secret\n");
      const write = await node.run(agentId, "write", { path, content: "overwritten" });
      expect(textOf(write), `write ${path}`).toContain("is outside the workspace");
      const edit = await node.run(agentId, "edit", {
        path,
        edits: [{ oldText: "secret", newText: "edited" }],
      });
      expect(textOf(edit), `edit ${path}`).toContain("is outside the workspace");
    }
    const created = await node.run(agentId, "write", { path: "link/new.txt", content: "x" });
    expect(textOf(created)).toContain("is outside the workspace");

    expect(readFileSync(join(outside, "secret.txt"), "utf8"), "nothing outside changed").toBe(
      "secret",
    );
    expect(existsSync(join(outside, "new.txt"))).toBe(false);
    expect(existsSync(join(outside, "not-yet.txt"))).toBe(false);
    expect(existsSync(join(workspace, "..", "escaped.txt"))).toBe(false);

    mkdirSync(join(workspace, "inside"));
    symlinkSync(
      join(workspace, "inside"),
      join(workspace, "inner-link"),
      windows ? "junction" : "dir",
    );
    const inward = await node.run(agentId, "write", {
      path: join(workspace, "inner-link", "ok.txt"),
      content: "fine",
    });
    if (windows) {
      expect(inward.isError, "junctions inside the workspace are refused too").toBe(true);
      expect(textOf(inward)).toContain("is outside the workspace");
      expect(existsSync(join(workspace, "inside", "ok.txt"))).toBe(false);
    } else {
      expect(inward.isError, "an absolute path or link that stays inside is allowed").toBe(false);
      expect(readFileSync(join(workspace, "inside", "ok.txt"), "utf8")).toBe("fine");
    }
  });

  it.runIf(windows)(
    "confines Windows drives, separators, aliases and case-insensitive paths",
    async () => {
      const node = await connectedNode();
      const { agentId, workspace } = await node.agent();
      const drive = parse(workspace).root.slice(0, 2);
      const otherDrive = drive.toUpperCase() === "Z:" ? "Y:" : "Z:";
      for (const path of [
        "..\\outside.txt",
        "inside\\..\\outside.txt",
        `${otherDrive}\\outside.txt`,
        `${drive}relative.txt`,
        drive,
        "\\outside.txt",
        "\\\\localhost\\share\\outside.txt",
      ]) {
        const result = await node.run(agentId, "write", { path, content: "refused" });
        expect(result.isError, path).toBe(true);
        expect(textOf(result), path).toContain("is outside the workspace");
      }
      const path = join(workspace, "MiXeD.txt").toUpperCase();
      const written = await node.run(agentId, "write", { path, content: "inside" });
      expect(written.isError, textOf(written)).toBe(false);
      const read = await node.run(agentId, "read", { path: "mixed.txt" });
      expect(textOf(read)).toBe("inside");
    },
  );

  it.runIf(windows)(
    "reads, writes, edits and browses the same directory through its short and long names",
    async () => {
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
    },
  );

  it.runIf(windows)("uses a workspace beneath a configured junction", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    const physicalRoot = `${node.workspacesRoot}-physical`;
    renameSync(node.workspacesRoot, physicalRoot);
    symlinkSync(physicalRoot, node.workspacesRoot, "junction");
    const path = join(workspace, "notes", "today.txt");

    const written = await node.run(agentId, "write", { path, content: "before" });
    expect(written.isError, textOf(written)).toBe(false);
    const edited = await node.run(agentId, "edit", {
      path,
      edits: [{ oldText: "before", newText: "after" }],
    });
    expect(edited.isError, textOf(edited)).toBe(false);
    expect(textOf(await node.run(agentId, "read", { path }))).toBe("after");
    expect(await node.gateway.browse(randomUUID(), agentId, path)).toMatchObject({
      ok: true,
      listing: { kind: "file", content: "after" },
    });
  });

  it.runIf(windows)(
    "refuses Windows file symlinks, including dangling and inward links",
    async (context) => {
      const node = await connectedNode();
      const { agentId, workspace } = await node.agent();
      const outside = temporaryDirectory();
      writeFileSync(join(workspace, "inside.txt"), "inside");
      writeFileSync(join(outside, "secret.txt"), "outside");
      try {
        symlinkSync(join(workspace, "inside.txt"), join(workspace, "inward.txt"), "file");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
        context.skip(
          "Windows file symlink creation requires Developer Mode or SeCreateSymbolicLinkPrivilege; junction confinement is tested without it",
        );
      }
      symlinkSync(join(outside, "secret.txt"), join(workspace, "outward.txt"), "file");
      symlinkSync(join(outside, "missing.txt"), join(workspace, "dangling.txt"), "file");
      for (const path of ["inward.txt", "outward.txt", "dangling.txt"]) {
        for (const tool of ["read", "write"] as const) {
          const result = await node.run(agentId, tool, { path, content: "overwrite" });
          expect(result.isError, `${tool} ${path}`).toBe(true);
          expect(textOf(result)).toContain("is outside the workspace");
        }
      }
      expect(readFileSync(join(workspace, "inside.txt"), "utf8")).toBe("inside");
      expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("outside");
      expect(existsSync(join(outside, "missing.txt"))).toBe(false);
    },
  );

  it("treats names that only begin with two dots as ordinary names inside the workspace", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    const paths = ["..notes.md", "..cache/x.txt"];
    if (!windows) paths.push("...");
    for (const path of paths) {
      const written = await node.run(agentId, "write", { path, content: path });
      expect(written.isError, `write ${path}: ${textOf(written)}`).toBe(false);
      expect(readFileSync(join(workspace, path), "utf8")).toBe(path);
      const read = await node.run(agentId, "read", { path });
      expect(textOf(read), `read ${path}`).toBe(path);
    }
  });

  it("reports a file that keeps changing while it is read instead of mixing old and new content", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    const path = join(workspace, "busy.txt");
    const line = (letter: string) => `${letter.repeat(99)}\n`;
    writeFileSync(path, line("a").repeat(40_000));
    // Another process rewrites the file in place, alternating every line between all a's and all b's.
    const writer = spawn(process.execPath, [
      "-e",
      `const fs = require("node:fs");
       const fd = fs.openSync(${JSON.stringify(path)}, "r+");
       const versions = ["a", "b"].map((l) => Buffer.from((l.repeat(99) + "\\n").repeat(40000)));
       for (let i = 0; ; i++) fs.writeSync(fd, versions[i % 2], 0, versions[0].length, 0);`,
    ]);
    onTestFinished(() => void writer.kill("SIGKILL"));
    await new Promise((resolve) => setTimeout(resolve, 200));

    let changed = 0;
    for (let attempt = 0; attempt < 20; attempt++) {
      const result = await node.run(agentId, "read", { path: "busy.txt", limit: 300 });
      const text = textOf(result);
      if (result.isError) {
        expect(text).toContain("busy.txt changed while it was read");
        changed++;
        continue;
      }
      const lines = text.split("\n").filter((l) => l !== "" && !l.startsWith("["));
      expect(lines.length).toBe(300);
      expect(new Set(lines).size, "never a mix of the two versions").toBe(1);
      expect(lines[0]).toMatch(/^(a{99}|b{99})$/);
    }
    expect(changed, "a file that never holds still is reported as changed").toBeGreaterThan(0);
  });
});
