import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { onTestFinished, describe, expect, it } from "vitest";
import { connectedNode, temporaryDirectory, textOf } from "./support.ts";

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
    symlinkSync(outside, join(workspace, "link"));
    symlinkSync(join(outside, "secret.txt"), join(workspace, "secret-link.txt"));
    symlinkSync(join(outside, "not-yet.txt"), join(workspace, "dangling.txt"));
    const escapes = [
      "../escaped.txt",
      join(outside, "secret.txt"),
      "link/secret.txt",
      "secret-link.txt",
    ];

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
    const dangling = await node.run(agentId, "write", { path: "dangling.txt", content: "x" });
    expect(textOf(dangling)).toContain("is outside the workspace");

    expect(readFileSync(join(outside, "secret.txt"), "utf8"), "nothing outside changed").toBe(
      "secret",
    );
    expect(existsSync(join(outside, "new.txt"))).toBe(false);
    expect(existsSync(join(outside, "not-yet.txt"))).toBe(false);
    expect(existsSync(join(workspace, "..", "escaped.txt"))).toBe(false);

    mkdirSync(join(workspace, "inside"));
    symlinkSync(join(workspace, "inside"), join(workspace, "inner-link"));
    const inward = await node.run(agentId, "write", {
      path: join(workspace, "inner-link", "ok.txt"),
      content: "fine",
    });
    expect(inward.isError, "an absolute path or link that stays inside is allowed").toBe(false);
    expect(readFileSync(join(workspace, "inside", "ok.txt"), "utf8")).toBe("fine");
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
