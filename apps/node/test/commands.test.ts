import {
  decodeMemoryReadOutcome,
  decodeTerminalWaitOutcome,
  EXEC_YIELD_MS,
  MEMORY_MAX_BYTES,
  TERMINAL_TIMEOUT_MS,
} from "@palace/node-protocol";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  connectedNode,
  eventually,
  execCommand,
  linux,
  longCommand,
  pidsOf,
  readPid,
  running,
  scriptCommand,
  temporaryDirectory,
  textOf,
  waitTerminal,
  windows,
  writeStdin,
} from "./support.ts";

describe("node commands (TESTS 1.1)", () => {
  it("uses the account shell with the workspace as initial directory and platform HOME", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    const result = await execCommand(node, agentId, {
      command: windows
        ? "$PSVersionTable.PSVersion.Major; (Get-Location).Path; $HOME"
        : `printf '%s\\n' "$0" "$(pwd -P)" "$HOME"`,
    });
    expect(result.isError, textOf(result)).toBe(false);
    const [shell, cwd, home] = textOf(result).split(/\r?\n/);
    expect(shell).toBe(windows ? "5" : userInfo().shell);
    expect(realpathSync.native(cwd!), "the shell is in the workspace directory").toBe(
      realpathSync.native(workspace),
    );
    expect(home).toBe(windows ? workspace : node.home);
  });

  it("exposes PALACE_MEMORY_DIR pointing at the workspace memory directory", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    const result = await execCommand(node, agentId, {
      command: windows ? "Write-Output $env:PALACE_MEMORY_DIR" : 'printf "%s" "$PALACE_MEMORY_DIR"',
    });
    expect(result.isError, textOf(result)).toBe(false);
    expect(realpathSync.native(textOf(result).trim())).toBe(
      realpathSync.native(join(workspace, "memory")),
    );
  });

  it.skipIf(windows)(
    "runs sudo only when the Agent wrote it, and never adds it (POSIX sudo)",
    async () => {
      const bin = join(temporaryDirectory(), "bin");
      mkdirSync(bin);
      const log = join(bin, "sudo.log");
      writeFileSync(join(bin, "sudo"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexec "$@"\n`);
      chmodSync(join(bin, "sudo"), 0o755);
      const node = await connectedNode({ env: { PATH: `${bin}:${process.env["PATH"]}` } });
      const { agentId } = await node.agent();

      const plain = await execCommand(node, agentId, { command: "echo plain" });
      expect(textOf(plain)).toContain("plain");
      expect(existsSync(log), "a command without sudo never runs sudo").toBe(false);

      const elevated = await execCommand(node, agentId, { command: "sudo echo elevated" });
      expect(textOf(elevated), "the host's sudo decides; this one just runs it").toContain(
        "elevated",
      );
      expect(readFileSync(log, "utf8"), "sudo got exactly what the Agent wrote").toBe(
        "echo elevated\n",
      );
    },
  );

  it("reports successful commands and explicit nonzero shell exit codes", async () => {
    const node = await connectedNode();
    const { agentId } = await node.agent();

    const ok = await execCommand(node, agentId, { command: "echo fine" });
    expect(ok.isError).toBe(false);
    expect(textOf(ok).trimEnd()).toBe("fine");

    const failed = await execCommand(node, agentId, { command: "echo partial; exit 3" });
    expect(failed.isError).toBe(true);
    expect(textOf(failed), "output survives a nonzero exit").toContain("partial");
    expect(textOf(failed)).toContain("Command exited with code 3");
  });

  it.runIf(windows)("preserves native command exit codes", async () => {
    const node = await connectedNode();
    const { agentId } = await node.agent();
    const result = await execCommand(node, agentId, { command: "cmd /c exit 5" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Command exited with code 5");
  });

  it.runIf(windows)("uses the last command's success after a native failure", async () => {
    const node = await connectedNode();
    const { agentId } = await node.agent();
    const result = await execCommand(node, agentId, {
      command: "cmd /c exit 3; Write-Output done",
    });
    expect(result.isError, textOf(result)).toBe(false);
    expect(textOf(result).trimEnd()).toBe("done");
  });

  it.skipIf(windows)("distinguishes a POSIX signal from a shell exit code", async () => {
    const node = await connectedNode();
    const { agentId } = await node.agent();
    const killed = await execCommand(node, agentId, { command: "kill -TERM $$" });
    expect(killed.isError).toBe(true);
    expect(textOf(killed)).toContain("Command was killed by signal SIGTERM");
    expect(textOf(killed)).not.toContain("exited with code");
  });

  it("kills the whole process group of a command that runs past its timeout", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    const timeoutMs = windows ? 5000 : 1000;
    const started = Date.now();
    const result = await execCommand(node, agentId, {
      command: longCommand("timeout"),
      timeoutMs,
    });
    expect(Date.now() - started, "returns at the timeout, not when the tree ends").toBeLessThan(
      windows ? 20_000 : 5000,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("waiting");
    expect(textOf(result)).toContain(`Command timed out after ${timeoutMs} ms and was killed`);
    for (const pid of await pidsOf(workspace, "timeout")) {
      await eventually(() => !running(pid), `process ${pid} is killed`);
    }
  });

  it("refuses, without running it, a command whose timeout or yield exceeds protocol limits", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    for (const [label, args] of [
      ["timeoutMs", { command: "echo ran > ran", timeoutMs: TERMINAL_TIMEOUT_MS.max + 1 }],
      ["yieldTimeMs", { command: "echo ran > ran", yieldTimeMs: EXEC_YIELD_MS.max + 1 }],
    ] as const) {
      const result = await execCommand(node, agentId, args);
      expect(result.isError, label).toBe(true);
      expect(textOf(result), label).toMatch(/Invalid terminal_exec arguments/);
      expect(existsSync(join(workspace, "ran")), `nothing ran for bad ${label}`).toBe(false);
    }

    const long = await execCommand(node, agentId, {
      command: "echo allowed",
      timeoutMs: TERMINAL_TIMEOUT_MS.max,
    });
    expect(textOf(long).split(/\r?\n/)[0]).toBe("allowed");
  });

  it("reports a command the system cannot start as not started", async () => {
    const node = await connectedNode();
    const { agentId } = await node.agent();
    const result = await execCommand(node, agentId, { command: "echo a\u0000b" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Command could not start");
    const next = await execCommand(node, agentId, { command: "echo still-serving" });
    expect(textOf(next).split(/\r?\n/)[0], "the node keeps serving").toBe("still-serving");
  });

  it("fails clearly, without starting anything, when the workspace is missing", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    rmSync(workspace, { recursive: true });
    const result = await execCommand(node, agentId, { command: "touch created-by-command" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/workspace .* does not exist/);
    expect(existsSync(workspace), "the node never recreates a workspace").toBe(false);
  });

  it("runs a command in a specified relative or missing workdir", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    mkdirSync(join(workspace, "sub"));
    const inSub = await execCommand(node, agentId, {
      command: windows ? "(Get-Location).Path" : "pwd -P",
      workdir: "sub",
    });
    expect(inSub.isError, textOf(inSub)).toBe(false);
    expect(realpathSync.native(textOf(inSub).trim())).toBe(
      realpathSync.native(join(workspace, "sub")),
    );

    const missing = await execCommand(node, agentId, { command: "echo no", workdir: "absent" });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("does not exist");
  });

  it("keeps the tail of output beyond the limit and says it truncated", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    let streamed = 0;
    const result = await execCommand(
      node,
      agentId,
      {
        command: scriptCommand(
          workspace,
          'process.stdout.write("a".repeat(300000) + "\\nEND-OF-OUTPUT\\n");',
        ),
      },
      (chunk) => (streamed += chunk.length),
    );
    expect(result.isError).toBe(false);
    const text = textOf(result);
    expect(text, "the end of the output is kept").toContain("END-OF-OUTPUT");
    expect(text).toMatch(/Output truncated: the first \d+ bytes were dropped/);
    expect(text.length, "the result is bounded").toBeLessThan(100_000);
    expect(streamed, "the whole output streamed while it ran").toBeGreaterThan(300_000);
  });

  it("yields running sessions, exchanges incremental stdin/stdout, and supports kill", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    const interactive = scriptCommand(
      workspace,
      [
        'import { createInterface } from "node:readline";',
        'process.stdout.write("ready\\n");',
        "const rl = createInterface({ input: process.stdin });",
        'rl.on("line", (line) => process.stdout.write(`echo:${line}\\n`));',
        'rl.on("close", () => { process.stdout.write("bye\\n"); process.exit(0); });',
      ].join("\n"),
      "interactive",
    );

    const started = await execCommand(node, agentId, {
      command: interactive,
      yieldTimeMs: 250,
    });
    expect(started.isError, textOf(started)).toBe(false);
    expect(started.outcome).toMatchObject({ running: true, sessionId: started.sessionId });
    let initialOutput = started.outcome?.output ?? "";
    if (!initialOutput.includes("ready")) {
      await vi.waitFor(
        async () => {
          const poll = await writeStdin(node, agentId, {
            sessionId: started.sessionId,
            yieldTimeMs: 250,
          });
          expect(poll.outcome).toMatchObject({ running: true });
          initialOutput += poll.outcome?.output ?? "";
          expect(initialOutput).toContain("ready");
        },
        { timeout: 10_000, interval: 25 },
      );
    }

    const firstWrite = await writeStdin(node, agentId, {
      sessionId: started.sessionId,
      chars: "hello\n",
      yieldTimeMs: 250,
    });
    expect(firstWrite.outcome).toMatchObject({ running: true });
    let step1Output = firstWrite.outcome?.output ?? "";
    if (!step1Output.includes("echo:hello")) {
      await vi.waitFor(
        async () => {
          const poll = await writeStdin(node, agentId, {
            sessionId: started.sessionId,
            yieldTimeMs: 250,
          });
          expect(poll.outcome).toMatchObject({ running: true });
          step1Output += poll.outcome?.output ?? "";
          expect(step1Output).toContain("echo:hello");
        },
        { timeout: 10_000, interval: 25 },
      );
    }
    expect(step1Output).not.toContain("ready");

    const step2 = await writeStdin(node, agentId, {
      sessionId: started.sessionId,
      chars: "world\n",
      eof: true,
      yieldTimeMs: 5000,
    });
    expect(step2.isError, textOf(step2)).toBe(false);
    expect(step2.outcome).toMatchObject({
      running: false,
      ending: { kind: "exited", code: 0 },
    });
    expect(step2.outcome?.output).toContain("echo:world");
    expect(step2.outcome?.output).toContain("bye");

    // terminal_wait sees the exit was already consumed by write_stdin.
    expect(await waitTerminal(node, agentId, started.sessionId)).toEqual({
      ok: true,
      outcome: { consumed: true },
    });

    // Kill via write_stdin stops the whole process group and consumes exit.
    const killedStart = await execCommand(node, agentId, {
      command: longCommand("write-kill"),
      yieldTimeMs: 0,
    });
    expect(killedStart.outcome?.running).toBe(true);
    const pids = await pidsOf(workspace, "write-kill");
    expect(pids.every(running)).toBe(true);

    const killed = await writeStdin(node, agentId, {
      sessionId: killedStart.sessionId,
      kill: true,
    });
    expect(killed.isError).toBe(false);
    expect(killed.outcome).toMatchObject({ running: false, ending: { kind: "killed" } });
    for (const pid of pids) await eventually(() => !running(pid), `killed pid ${pid}`);
    expect(await waitTerminal(node, agentId, killedStart.sessionId)).toEqual({
      ok: true,
      outcome: { consumed: true },
    });
  });

  it("delivers unconsumed detached exits through terminal_wait once", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    const cmd = scriptCommand(
      workspace,
      'setTimeout(() => { process.stdout.write("finished-later\\n"); process.exit(2); }, 80);',
      "later",
    );
    const started = await execCommand(node, agentId, { command: cmd, yieldTimeMs: 10 });
    expect(started.outcome?.running).toBe(true);

    const waited = await waitTerminal(node, agentId, started.sessionId);
    expect(waited).toMatchObject({
      ok: true,
      outcome: {
        consumed: false,
        outcome: {
          running: false,
          sessionId: started.sessionId,
          output: "finished-later\n",
          ending: { kind: "exited", code: 2 },
        },
      },
    });
  });

  it("delivers exit notification to multiple concurrent terminal_wait callers and tracks write_stdin consumption per conversation", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    const shared = scriptCommand(
      workspace,
      'setTimeout(() => { process.stdout.write("both-see-me\\n"); process.exit(0); }, 250);',
      "shared-wait",
    );
    const first = await execCommand(
      node,
      agentId,
      { command: shared, yieldTimeMs: 10 },
      undefined,
      undefined,
      0,
    );
    expect(first.outcome?.running).toBe(true);

    const wait0 = node.run(
      agentId,
      "terminal_wait",
      { sessionId: first.sessionId },
      undefined,
      undefined,
      0,
    );
    const wait1 = node.run(
      agentId,
      "terminal_wait",
      { sessionId: first.sessionId },
      undefined,
      undefined,
      1,
    );
    const [res0, res1] = await Promise.all([wait0, wait1]);
    expect(decodeTerminalWaitOutcome(res0)).toMatchObject({
      ok: true,
      outcome: {
        consumed: false,
        outcome: { sessionId: first.sessionId, output: "both-see-me\n" },
      },
    });
    expect(decodeTerminalWaitOutcome(res1)).toMatchObject({
      ok: true,
      outcome: {
        consumed: false,
        outcome: { sessionId: first.sessionId, output: "both-see-me\n" },
      },
    });

    // Consuming exit via write_stdin in conversation 1 suppresses only conversation 1's waiter.
    const gated = scriptCommand(
      workspace,
      [
        'let buf = "";',
        'process.stdin.on("data", (c) => (buf += c));',
        'process.stdin.on("end", () => { process.stdout.write("only-0-watches\\n"); process.exit(0); });',
      ].join("\n"),
      "per-conv-consume",
    );
    const second = await execCommand(
      node,
      agentId,
      { command: gated, yieldTimeMs: 10 },
      undefined,
      undefined,
      0,
    );
    expect(second.outcome?.running).toBe(true);

    const p0 = node.run(
      agentId,
      "terminal_wait",
      { sessionId: second.sessionId },
      undefined,
      undefined,
      0,
    );
    const p1 = node.run(
      agentId,
      "terminal_wait",
      { sessionId: second.sessionId },
      undefined,
      undefined,
      1,
    );
    const w1 = await node.run(
      agentId,
      "terminal_write",
      { sessionId: second.sessionId, eof: true, yieldTimeMs: 5000 },
      undefined,
      undefined,
      1,
    );
    expect(w1.isError).toBe(false);
    const [o0, o1] = await Promise.all([p0, p1]);
    expect(decodeTerminalWaitOutcome(o1)).toEqual({ ok: true, outcome: { consumed: true } });
    expect(decodeTerminalWaitOutcome(o0)).toMatchObject({
      ok: true,
      outcome: {
        consumed: false,
        outcome: { sessionId: second.sessionId, output: "only-0-watches\n" },
      },
    });
  });

  it("reads memory/MEMORY.md via memory_read with truncation and safety checks", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();

    const readMemory = async () =>
      decodeMemoryReadOutcome(await node.run(agentId, "memory_read", {}));

    expect(await readMemory()).toEqual({ ok: true, outcome: { status: "missing" } });

    const memoryFile = join(workspace, "memory", "MEMORY.md");
    writeFileSync(memoryFile, "fact one\n");
    expect(await readMemory()).toEqual({
      ok: true,
      outcome: { status: "ok", content: "fact one\n", truncated: false },
    });

    // UTF-8 multi-byte character straddling MEMORY_MAX_BYTES must not produce U+FFFD.
    writeFileSync(memoryFile, `${"a".repeat(MEMORY_MAX_BYTES - 1)}étail`);
    const truncated = await readMemory();
    expect(truncated).toEqual({
      ok: true,
      outcome: { status: "ok", content: "a".repeat(MEMORY_MAX_BYTES - 1), truncated: true },
    });

    if (!windows) {
      const outside = join(temporaryDirectory(), "secret.md");
      writeFileSync(outside, "secret");
      rmSync(memoryFile);
      symlinkSync(outside, memoryFile);
      expect(await readMemory()).toMatchObject({
        ok: true,
        outcome: { status: "unreadable" },
      });
    }
  });

  it.skipIf(windows)(
    "returns soon when a POSIX background process keeps the output open",
    async () => {
      const node = await connectedNode();
      const { agentId, workspace } = await node.agent();
      const started = Date.now();
      const result = await execCommand(node, agentId, {
        command: "sleep 30 & echo $! > background.pid; echo started",
      });
      expect(Date.now() - started, "does not wait for the background process").toBeLessThan(5000);
      expect(result.isError).toBe(false);
      expect(textOf(result)).toContain("started");
      expect(textOf(result)).toContain("Output may be incomplete");
      expect(
        running(readPid(join(workspace, "background.pid"))),
        "the background is left alone",
      ).toBe(true);
    },
  );

  it.skipIf(windows)("reports POSIX background processes after the shell returns", async () => {
    const node = await connectedNode();
    const { agentId } = await node.agent();
    const result = await execCommand(node, agentId, {
      command: "sleep 30 > /dev/null 2>&1 & echo started",
    });
    expect(textOf(result)).toContain(
      "Background processes started by this command are still running",
    );
    expect(textOf(result)).not.toContain("Output may be incomplete");
  });

  it.runIf(linux)("counts a process group with only zombies left as finished", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    writeFileSync(
      join(workspace, "helper.pl"),
      [
        "use POSIX;",
        "my $g = getpgrp(); setpgid(0, 0);",
        "pipe(my $r, my $w);",
        "my $c = fork();",
        "if (!$c) { close $w; sysread($r, my $b, 1); POSIX::_exit(0); }",
        "close $r; setpgid($c, $g) or die; close $w;",
        'open(my $f, ">", "zombie.pid"); print $f $c; close $f;',
        'open($f, ">", "helper.pid"); print $f $$; close $f;',
        "sleep 30;",
      ].join("\n"),
    );
    const result = await execCommand(node, agentId, {
      command:
        "perl helper.pl > /dev/null 2>&1 & while [ ! -s helper.pid ]; do sleep 0.05; done; sleep 0.2; echo done",
      timeoutMs: 10_000,
    });
    const zombie = readPid(join(workspace, "zombie.pid"));
    try {
      expect(readFileSync(`/proc/${zombie}/stat`, "utf8"), "the child is a zombie").toMatch(
        /\) Z /,
      );
      expect(textOf(result)).toContain("done");
      expect(textOf(result), "a zombie is not a running background process").not.toContain(
        "still running",
      );
    } finally {
      process.kill(readPid(join(workspace, "helper.pid")), "SIGKILL");
    }
  });
});
