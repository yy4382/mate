import { afterEach, expect, it } from "vitest";
import {
  writeFileSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  chmodSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import type { Operation, WorkspaceFailureCode } from "@mate/protocol";
import { SameAccountFileBackend } from "../../src/files/same-account-files.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.skipIf(process.getuid!() === 0)(
  "reports a native move permission failure without modifying either directory",
  async () => {
    const root = workspace(),
      protectedDirectory = join(root, "protected"),
      backend = new SameAccountFileBackend({ ...identity, home: root });
    mkdirSync(protectedDirectory, { mode: 0o500 });
    writeFileSync(join(root, "source.txt"), "source remains intact");
    try {
      const result = await backend.execute({
        root,
        timeoutMs: 5_000,
        operation: { kind: "move", path: "source.txt", destination: "protected/moved.txt" },
      });
      expect(result).toMatchObject({ code: 1, errorCode: "permission_denied" });
      expect(result.stderr).toContain("atomic_move_failed:");
      expect(readFileSync(join(root, "source.txt"), "utf8")).toBe("source remains intact");
      expect(() => readFileSync(join(protectedDirectory, "moved.txt"))).toThrow();
    } finally {
      chmodSync(protectedDirectory, 0o700);
    }
  },
);
function workspace() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mate-same-account-files-")));
  roots.push(root);
  return root;
}
const identity = { uid: process.getuid!(), gid: process.getgid!(), home: homedir() };

it("keeps provisioner-only identity metadata outside the strict execution backend schema", () => {
  const provisionedIdentity = { ...identity, username: "alice", homeMarker: "a".repeat(64) };
  expect(() => new SameAccountFileBackend(provisionedIdentity)).toThrow();
});

it("creates peer-readable work products without making private home files peer-readable", async () => {
  const privateRoot = workspace(),
    shared = workspace(),
    backend = new SameAccountFileBackend({ ...identity, home: privateRoot });
  for (const root of [privateRoot, shared]) {
    expect(
      (
        await backend.execute({
          agentId: "alice",
          root,
          timeoutMs: 5000,
          operation: { kind: "write", path: "file.txt", content: "work" },
        })
      ).code,
    ).toBe(0);
  }
  expect(statSync(join(privateRoot, "file.txt")).mode & 0o777).toBe(0o600);
  expect(statSync(join(shared, "file.txt")).mode & 0o777).toBe(0o644);
});

it("refuses a different execution account at call time", async () => {
  const root = workspace();
  for (const account of [
    { ...identity, uid: identity.uid + 1 },
    { ...identity, gid: identity.gid + 1 },
  ]) {
    const backend = new SameAccountFileBackend(account);
    await expect(
      backend.execute({ root, timeoutMs: 1000, operation: { kind: "read", path: "." } }),
    ).rejects.toThrow("account");
  }
});

it("keeps the file helper environment private and supplies the workspace home and CLI path", async () => {
  const root = workspace(),
    helper = join(root, "environment.cjs");
  writeFileSync(helper, "process.stdin.resume();process.stdout.write(JSON.stringify(process.env))");
  process.env.MATE_FILE_ENV_TEST = "not-for-helper";
  try {
    const backend = new SameAccountFileBackend(
      { ...identity, home: root, username: "account" },
      helper,
    );
    const result = await backend.execute({
      root,
      timeoutMs: 5000,
      operation: { kind: "read", path: "." },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).MATE_FILE_ENV_TEST).toBeUndefined();
    expect(JSON.parse(result.stdout)).toMatchObject({
      HOME: root,
      USER: "account",
      LOGNAME: "account",
      LANG: "C.UTF-8",
      PATH: `${root}/.local/bin:${root}/bin:/usr/local/bin:/usr/bin:/bin`,
    });
  } finally {
    delete process.env.MATE_FILE_ENV_TEST;
  }
});

it("cancels and times out a file helper without blocking other work", async () => {
  const root = workspace(),
    helper = join(root, "waiting.cjs");
  writeFileSync(helper, "process.stdin.resume();setInterval(()=>{},1000)");
  const backend = new SameAccountFileBackend(identity, helper),
    controller = new AbortController();
  const request = { root, timeoutMs: 5000, operation: { kind: "read" as const, path: "." } };
  const running = backend.execute(request, controller.signal);
  const cancelled = expect(running).rejects.toThrow("outcome may be unknown");
  await new Promise((resolve) => setTimeout(resolve, 50));
  controller.abort();
  await cancelled;
  await expect(backend.execute({ ...request, timeoutMs: 50 })).rejects.toThrow("timed out");
  await expect(backend.execute(request, controller.signal)).rejects.toThrow("aborted");
});

it("carries real helper path, version, missing-file and permission failures by code", async () => {
  const root = workspace();
  writeFileSync(join(root, "file.txt"), "original");
  writeFileSync(join(root, "protected.txt"), "private", { mode: 0o000 });
  symlinkSync("file.txt", join(root, "link.txt"));
  const backend = new SameAccountFileBackend({ ...identity, home: root });
  const cases: Array<{ operation: Operation; errorCode: WorkspaceFailureCode }> = [
    { operation: { kind: "read", path: "missing.txt" }, errorCode: "not_found" },
    { operation: { kind: "read", path: "link.txt" }, errorCode: "unsafe_path" },
    {
      operation: {
        kind: "edit",
        path: "file.txt",
        oldText: "original",
        newText: "changed",
        expectedHash: "0".repeat(64),
      },
      errorCode: "file_changed",
    },
    { operation: { kind: "read", path: "." }, errorCode: "not_file" },
  ];
  if (process.getuid!() !== 0)
    cases.push({
      operation: { kind: "read", path: "protected.txt" },
      errorCode: "permission_denied",
    });
  try {
    for (const testCase of cases) {
      const result = await backend.execute({
        root,
        timeoutMs: 5_000,
        operation: testCase.operation,
      });
      expect(result.code).not.toBe(0);
      expect(result.errorCode).toBe(testCase.errorCode);
      expect(result.stderr.length).toBeGreaterThan(0);
    }
    expect(
      await backend.execute({
        root,
        timeoutMs: 5_000,
        operation: { kind: "read", path: "file.txt" },
      }),
    ).toMatchObject({ code: 0, stderr: "" });
  } finally {
    chmodSync(join(root, "protected.txt"), 0o600);
  }
});
