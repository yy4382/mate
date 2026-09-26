import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";
import { LinuxUserBackend, linuxScopeCommand } from "../../src/execution/linux-user.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function workspace() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mate-linux-user-")));
  roots.push(root);
  return root;
}
const identity = { uid: process.getuid!(), gid: process.getgid!(), home: homedir() };

it("places each Linux call in its Agent slice with groups cleared before the command", () => {
  const call = linuxScopeCommand(
    { uid: 1001, gid: 1001, home: "/srv/agents/alice" },
    "/srv/agents/alice",
    "/bin/sh",
    ["-c", "sleep 30 &"],
    "mate-agent-1001-12345678-1234-4234-8234-123456789abc",
  );
  expect(call.command).toBe("/usr/bin/systemd-run");
  expect(call.unit).toBe("mate-agent-1001-12345678-1234-4234-8234-123456789abc.scope");
  expect(call.args).not.toContain("--expand-environment=no");
  expect(call.args).toEqual(
    expect.arrayContaining([
      "--scope",
      "--collect",
      "--slice=mate-agent-1001.slice",
      "--working-directory=/srv/agents/alice",
      "/usr/bin/setpriv",
      "--reuid=1001",
      "--regid=1001",
      "--clear-groups",
      "--no-new-privs",
      "/bin/sh",
      "-c",
      "sleep 30 &",
    ]),
  );
});

it("keeps provisioner-only identity metadata outside the strict execution backend schema", () => {
  const provisionedIdentity = { ...identity, username: "alice", homeMarker: "a".repeat(64) };
  expect(() => new LinuxUserBackend({ alice: provisionedIdentity })).toThrow();
});

it("runs file tools and shell under one stable host identity and path", async () => {
  const root = workspace(),
    backend = new LinuxUserBackend({ alice: identity });
  const request = { agentId: "alice", root, timeoutMs: 5000 };
  const write = await backend.execute({
    ...request,
    operation: { kind: "write", path: "note.txt", content: "from file tool" },
  });
  expect(write.code).toBe(0);
  const shell = await backend.execute({
    ...request,
    operation: {
      kind: "exec",
      cwd: ".",
      command: 'printf "%s\\n" "$HOME" "$PWD" "$(id -u)"; cat note.txt',
    },
  });
  expect(shell).toMatchObject({
    code: 0,
    stdout: `${identity.home}\n${root}\n${identity.uid}\nfrom file tool`,
  });
  const created = await backend.execute({
    ...request,
    operation: { kind: "exec", cwd: ".", command: "printf from-shell > shell.txt" },
  });
  expect(created.code).toBe(0);
  expect(
    (await backend.execute({ ...request, operation: { kind: "read", path: "shell.txt" } })).stdout,
  ).toBe("from-shell");
  expect(readFileSync(join(root, "shell.txt"), "utf8")).toBe("from-shell");
});

it("accepts a symlink to a working directory like a normal shell", async () => {
  const root = workspace(),
    backend = new LinuxUserBackend({ alice: identity });
  symlinkSync(root, join(root, "linked"));
  const result = await backend.execute({
    agentId: "alice",
    root,
    timeoutMs: 5000,
    operation: { kind: "exec", cwd: "linked", command: "pwd" },
  });
  expect(result).toMatchObject({ code: 0, stdout: `${root}\n` });
});

it("returns after a normal background shell command without waiting for inherited output pipes", async () => {
  if (process.platform === "linux" && process.getuid?.() === 0) return; // The privileged branch is covered by the Debian scope test.
  const root = workspace(),
    backend = new LinuxUserBackend({ alice: identity });
  const result = await backend.execute({
    agentId: "alice",
    root,
    timeoutMs: 500,
    operation: { kind: "exec", cwd: ".", command: "sleep 2 &" },
  });
  expect(result).toMatchObject({ code: 0, truncated: true });
});

it("keeps complete foreground output when its pipes close normally", async () => {
  if (process.platform === "linux" && process.getuid?.() === 0) return;
  const root = workspace(),
    backend = new LinuxUserBackend({ alice: identity });
  const result = await backend.execute({
    agentId: "alice",
    root,
    timeoutMs: 5000,
    operation: { kind: "exec", cwd: ".", command: 'head -c 60000 /dev/zero | tr "\\000" x' },
  });
  expect(result.code).toBe(0);
  expect(result.stdout).toBe("x".repeat(60000));
  expect(result.truncated).toBe(false);
});

it("cancels an ordinary command promptly while other work keeps running", async () => {
  const root = workspace(),
    backend = new LinuxUserBackend({ alice: identity }),
    controller = new AbortController();
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
  }, 10);
  const request = { agentId: "alice", root, timeoutMs: 30000 };
  try {
    const running = backend.execute(
      { ...request, operation: { kind: "exec", cwd: ".", command: "sleep 5" } },
      controller.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const started = Date.now();
    controller.abort();
    await expect(running).rejects.toThrow("outcome may be unknown");
    expect(Date.now() - started).toBeLessThan(3000);
    expect(ticks).toBeGreaterThan(1);
    const timedOut = backend.execute({
      ...request,
      timeoutMs: 100,
      operation: { kind: "exec", cwd: ".", command: "sleep 5" },
    });
    await expect(timedOut).rejects.toThrow("timed out");
    expect(ticks).toBeGreaterThan(1);
  } finally {
    clearInterval(timer);
  }
});

it("rejects missing identity, but accepts ordinary parent paths", async () => {
  const root = workspace(),
    backend = new LinuxUserBackend({ alice: identity });
  await expect(
    backend.execute({
      agentId: "bob",
      root,
      timeoutMs: 1000,
      operation: { kind: "exec", cwd: ".", command: "id" },
    }),
  ).rejects.toThrow("Linux user");
  const parent = await backend.execute({
    agentId: "alice",
    root,
    timeoutMs: 1000,
    operation: { kind: "exec", cwd: "..", command: "pwd" },
  });
  expect(parent).toMatchObject({ code: 0, stdout: `${dirname(root)}\n` });
});

it("does not inherit the Mate process environment", async () => {
  const root = workspace(),
    backend = new LinuxUserBackend({ alice: identity });
  process.env.MATE_LINUX_USER_SECRET_TEST = "control-secret";
  try {
    const result = await backend.execute({
      agentId: "alice",
      root,
      timeoutMs: 5000,
      operation: {
        kind: "exec",
        cwd: ".",
        command: 'printf "%s" "${MATE_LINUX_USER_SECRET_TEST-unset}"',
      },
    });
    expect(result).toMatchObject({ code: 0, stdout: "unset" });
  } finally {
    delete process.env.MATE_LINUX_USER_SECRET_TEST;
  }
});

it("creates peer-readable work products without making private home files peer-readable", async () => {
  const privateRoot = workspace(),
    shared = workspace(),
    backend = new LinuxUserBackend({ alice: { ...identity, home: privateRoot } });
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
    expect(
      (
        await backend.execute({
          agentId: "alice",
          root,
          timeoutMs: 5000,
          operation: { kind: "exec", cwd: ".", command: "printf work > shell.txt" },
        })
      ).code,
    ).toBe(0);
  }
  expect(statSync(join(privateRoot, "file.txt")).mode & 0o777).toBe(0o600);
  expect(statSync(join(privateRoot, "shell.txt")).mode & 0o777).toBe(0o600);
  expect(statSync(join(shared, "file.txt")).mode & 0o777).toBe(0o644);
  expect(statSync(join(shared, "shell.txt")).mode & 0o777).toBe(0o644);
});

it("keeps a user-installed CLI in PATH on the next call", async () => {
  const home = workspace(),
    backend = new LinuxUserBackend({ alice: { ...identity, home } }),
    request = { agentId: "alice", root: home, timeoutMs: 5000 };
  const install = await backend.execute({
    ...request,
    operation: {
      kind: "exec",
      cwd: ".",
      command:
        'mkdir -p "$HOME/.local/bin"; printf "#!/bin/sh\\nprintf cli-ready\\n" > "$HOME/.local/bin/mate-test-cli"; chmod 700 "$HOME/.local/bin/mate-test-cli"',
    },
  });
  expect(install.code).toBe(0);
  expect(
    await backend.execute({
      ...request,
      operation: { kind: "exec", cwd: ".", command: "mate-test-cli" },
    }),
  ).toMatchObject({ code: 0, stdout: "cli-ready" });
});
