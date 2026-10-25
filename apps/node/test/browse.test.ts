import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BROWSE_DIRECTORY_ENTRIES, BROWSE_FILE_BYTES } from "@mate/node-protocol";
import { connectedNode, temporaryDirectory, windows, type NodeProcess } from "./support.ts";

const browse = (node: NodeProcess, agentId: string, path: string) =>
  node.gateway.browse(randomUUID(), agentId, path);

describe("node workspace browsing (MODULE_TESTS 8.4)", () => {
  it("lists a directory's entries by name, with sizes of files, and reads a text file", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    mkdirSync(join(workspace, "notes"));
    writeFileSync(join(workspace, "notes", "today.md"), "één\ntwo\n");
    writeFileSync(join(workspace, "..notes.md"), "dots");
    symlinkSync(join(workspace, "notes"), join(workspace, "latest"), windows ? "junction" : "dir");

    expect(await browse(node, agentId, ".")).toEqual({
      ok: true,
      listing: {
        kind: "directory",
        path: ".",
        entries: [
          { name: "..notes.md", kind: "file", size: 4 },
          { name: "MEMORY.md", kind: "file", size: 0 },
          { name: "latest", kind: "symlink" },
          { name: "notes", kind: "directory" },
        ],
        truncated: false,
      },
    });
    if (windows) {
      expect(
        await browse(node, agentId, "latest/today.md"),
        "Windows junctions are refused",
      ).toMatchObject({
        ok: false,
        reason: "outside-workspace",
      });
    } else
      expect(
        await browse(node, agentId, "latest/today.md"),
        "a POSIX link inside is followed",
      ).toEqual({
        ok: true,
        listing: {
          kind: "file",
          path: "latest/today.md",
          size: Buffer.byteLength("één\ntwo\n"),
          content: "één\ntwo\n",
          truncated: false,
        },
      });
    expect(
      await browse(node, agentId, join(workspace, "notes")),
      "an absolute path inside is allowed",
    ).toMatchObject({ ok: true, listing: { kind: "directory", path: "notes" } });
  });

  it("returns the start of a large file and part of a large directory, each marked truncated", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    // A two-byte character straddles the limit, so a cut there would split it.
    const text = `${"a".repeat(BROWSE_FILE_BYTES - 1)}é${"b".repeat(100)}`;
    writeFileSync(join(workspace, "big.txt"), text);
    mkdirSync(join(workspace, "many"));
    for (let i = 0; i <= BROWSE_DIRECTORY_ENTRIES; i++)
      writeFileSync(join(workspace, "many", `${i}`), "");

    expect(await browse(node, agentId, "big.txt")).toEqual({
      ok: true,
      listing: {
        kind: "file",
        path: "big.txt",
        size: Buffer.byteLength(text),
        content: "a".repeat(BROWSE_FILE_BYTES - 1),
        truncated: true,
      },
    });
    const many = await browse(node, agentId, "many");
    expect(many).toMatchObject({ ok: true, listing: { kind: "directory", truncated: true } });
    expect(many.ok && many.listing.kind === "directory" && many.listing.entries.length).toBe(
      BROWSE_DIRECTORY_ENTRIES,
    );
  });

  it("reports a file that is not text as binary, without its content", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    writeFileSync(join(workspace, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));

    expect(await browse(node, agentId, "image.png")).toEqual({
      ok: true,
      listing: { kind: "binary", path: "image.png", size: 7 },
    });
  });

  it("refuses paths that leave the workspace through .., an absolute path, or a symbolic link, and changes nothing", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    const outside = temporaryDirectory();
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(outside, join(workspace, "link"), windows ? "junction" : "dir");
    const paths = [
      "..",
      "../",
      `../${agentId}-other`,
      outside,
      join(outside, "secret.txt"),
      "link",
      "link/secret.txt",
    ];
    if (!windows) {
      symlinkSync(join(outside, "secret.txt"), join(workspace, "secret-link.txt"));
      symlinkSync(join(outside, "not-yet.txt"), join(workspace, "dangling.txt"));
      paths.push("secret-link.txt", "dangling.txt");
    }
    const before = readdirSync(workspace).sort();
    for (const path of paths) {
      const outcome = await browse(node, agentId, path);
      expect(outcome, path).toEqual({
        ok: false,
        reason: "outside-workspace",
        message: `${path} is outside the workspace`,
      });
    }
    expect(readdirSync(workspace).sort(), "browsing created nothing").toEqual(before);
    expect(readdirSync(outside), "or outside").toEqual(["secret.txt"]);
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("secret");
  });

  it("refuses a path that does not exist and a missing workspace", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();

    expect(await browse(node, agentId, "absent.txt")).toMatchObject({
      ok: false,
      reason: "not-found",
    });
    expect(await browse(node, agentId, "MEMORY.md/inside")).toMatchObject({
      ok: false,
      reason: "not-found",
    });

    rmSync(workspace, { recursive: true });
    expect(await browse(node, agentId, ".")).toMatchObject({ ok: false, reason: "not-found" });
    expect(readdirSync(node.workspacesRoot), "the node did not recreate it").not.toContain(agentId);
  });

  it.skipIf(windows)("refuses a POSIX FIFO without waiting for its writer", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    execFileSync("mkfifo", [join(workspace, "pipe")]);
    expect(await browse(node, agentId, "pipe")).toMatchObject({ ok: false, reason: "unreadable" });
  });
});
