import { BASH_TIMEOUT_SECONDS } from "@mate/node-protocol";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  connectedNode,
  eventually,
  linux,
  longCommand,
  pidsOf,
  readPid,
  running,
  scriptCommand,
  temporaryDirectory,
  textOf,
  windows,
} from "./support.ts";

describe("node commands (MODULE_TESTS 8.1)", () => {
  it("uses the system shell with the workspace as working directory and HOME", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    const result = await node.run(agentId, "bash", {
      command: windows
        ? "$PSVersionTable.PSVersion.Major; (Get-Location).Path; $HOME"
        : `printf '%s\\n' "$0" "$(pwd -P)" "$HOME"`,
    });
    expect(result.isError, textOf(result)).toBe(false);
    const [shell, cwd, home] = textOf(result).split(/\r?\n/);
    expect(shell).toBe(windows ? "5" : "/bin/sh");
    expect(realpathSync.native(cwd!), "the shell is in the workspace directory").toBe(
      realpathSync.native(workspace),
    );
    expect(home, "HOME keeps the configured workspace path").toBe(workspace);
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

      const plain = await node.run(agentId, "bash", { command: "echo plain" });
      expect(textOf(plain)).toContain("plain");
      expect(existsSync(log), "a command without sudo never runs sudo").toBe(false);

      const elevated = await node.run(agentId, "bash", { command: "sudo echo elevated" });
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

    const ok = await node.run(agentId, "bash", { command: "echo fine" });
    expect(ok.isError).toBe(false);
    expect(textOf(ok).trimEnd()).toBe("fine");

    const failed = await node.run(agentId, "bash", { command: "echo partial; exit 3" });
    expect(failed.isError).toBe(true);
    expect(textOf(failed), "output survives a nonzero exit").toContain("partial");
    expect(textOf(failed)).toContain("Command exited with code 3");
  });

  it.runIf(windows)("preserves native command exit codes", async () => {
    const node = await connectedNode();
    const { agentId } = await node.agent();
    const result = await node.run(agentId, "bash", { command: "cmd /c exit 5" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Command exited with code 5");
  });

  it.runIf(windows)(
    "parses PowerShell using declarations before any initialization statements",
    async () => {
      const node = await connectedNode();
      const { agentId } = await node.agent();
      const result = await node.run(agentId, "bash", {
        command: "using namespace System.IO; [Path]::GetFileName('a.txt')",
      });
      expect(result.isError, textOf(result)).toBe(false);
      expect(textOf(result).split(/\r?\n/)[0]).toBe("a.txt");
    },
  );

  it.runIf(windows)(
    "preserves PowerShell parameters, quoting, HOME, UTF-8 and explicit exit codes",
    async () => {
      const node = await connectedNode();
      const { agentId, workspace } = await node.agent();
      const result = await node.run(agentId, "bash", {
        command: [
          "param([string] $Name = 'a''b.txt')",
          "$Name",
          "'literal $HOME `n'",
          '"‘’‚‛"',
          "$HOME",
          "'你好，世界'",
          "exit 7",
        ].join("\n"),
      });
      expect(result.isError).toBe(true);
      expect(textOf(result).split(/\r?\n/).slice(0, 5)).toEqual([
        "a'b.txt",
        "literal $HOME `n",
        "‘’‚‛",
        workspace,
        "你好，世界",
      ]);
      expect(textOf(result)).toContain("Command exited with code 7");
    },
  );

  it.skipIf(windows)("distinguishes a POSIX signal from a shell exit code", async () => {
    const node = await connectedNode();
    const { agentId } = await node.agent();
    const killed = await node.run(agentId, "bash", { command: "kill -TERM $$" });
    expect(killed.isError).toBe(true);
    expect(textOf(killed)).toContain("Command was killed by signal SIGTERM");
    expect(textOf(killed)).not.toContain("exited with code");
  });

  it("kills the whole process group of a command that runs past its timeout", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    const started = Date.now();
    const result = await node.run(agentId, "bash", {
      command: longCommand("timeout"),
      timeout: 5,
    });
    expect(Date.now() - started, "returns at the timeout, not when the tree ends").toBeLessThan(
      20_000,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("waiting");
    expect(textOf(result)).toContain("Command timed out after 5 seconds and was killed");
    for (const pid of await pidsOf(workspace, "timeout")) {
      await eventually(() => !running(pid), `process ${pid} is killed`);
    }
  });

  it("refuses, without running it, a command whose timeout is past the protocol's maximum for its mode", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    const { foreground, background } = BASH_TIMEOUT_SECONDS;
    for (const [mode, args] of [
      ["foreground", { command: "echo ran > ran", timeout: foreground.max + 1 }],
      ["background", { command: "echo ran > ran", background: true, timeout: background.max + 1 }],
    ] as const) {
      const result = await node.run(agentId, "bash", args);
      expect(result.isError, mode).toBe(true);
      expect(textOf(result), mode).toMatch(/Invalid bash arguments/);
      expect(existsSync(join(workspace, "ran")), `nothing ran in the ${mode}`).toBe(false);
    }

    const long = await node.run(agentId, "bash", {
      command: "echo allowed",
      background: true,
      timeout: foreground.max + 1,
    });
    expect(
      textOf(long).split(/\r?\n/)[0],
      "a background command may ask for more than an hour",
    ).toBe("allowed");
  });

  it("reports a command the system cannot start as not started", async () => {
    const node = await connectedNode();
    const { agentId } = await node.agent();
    const result = await node.run(agentId, "bash", { command: "echo a\u0000b" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Command could not start");
    const next = await node.run(agentId, "bash", { command: "echo still-serving" });
    expect(textOf(next).split(/\r?\n/)[0], "the node keeps serving").toBe("still-serving");
  });

  it("fails clearly, without starting anything, when the workspace is missing", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    rmSync(workspace, { recursive: true });
    const result = await node.run(agentId, "bash", { command: "touch created-by-command" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/workspace .* does not exist/);
    expect(existsSync(workspace), "the node never recreates a workspace").toBe(false);
  });

  it("keeps the tail of output beyond the limit and says it truncated", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    let streamed = 0;
    const result = await node.run(
      agentId,
      "bash",
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

  it("preserves UTF-8 shell output and a multibyte tail after truncation", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    const greeting = await node.run(agentId, "bash", {
      command: windows ? "Write-Output '你好，世界'" : "printf '你好，世界\\n'",
    });
    expect(textOf(greeting)).toContain("你好，世界");
    const output = await node.run(agentId, "bash", {
      command: scriptCommand(
        workspace,
        'process.stdout.write("中".repeat(30000) + "结束");',
        "unicode",
      ),
    });
    expect(textOf(output)).toContain("结束");
    expect(textOf(output)).toContain("Output truncated");
    expect(textOf(output)).not.toContain("�");
  });

  it.skipIf(windows)(
    "returns soon when a POSIX background process keeps the output open",
    async () => {
      const node = await connectedNode();
      const { agentId, workspace } = await node.agent();
      const started = Date.now();
      const result = await node.run(agentId, "bash", {
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
    const result = await node.run(agentId, "bash", {
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
    // A helper outside the command's process group forks a child, moves it into that group, and never reaps it once
    // it exits: the group is then nothing but a zombie.
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
    const result = await node.run(agentId, "bash", {
      command:
        "perl helper.pl > /dev/null 2>&1 & while [ ! -s helper.pid ]; do sleep 0.05; done; sleep 0.2; echo done",
      timeout: 10,
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
