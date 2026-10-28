import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, join } from "node:path";
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

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const shell = basename(userInfo().shell ?? "");
const rc = shell === "bash" ? ".bashrc" : ".zshrc";

describe.skipIf(windows)("node shell context (MODULE_TESTS 8.1)", () => {
  it("restores startup functions and their scalar, array, readonly, export, alias and option dependencies once per node", async () => {
    const node = await connectedNode({
      env: { REMOVED: "inherited", PRIVATE: "inherited", SHELL: "/not/the/account/shell" },
    });
    const { agentId, workspace } = await node.agent();
    writeFileSync(join(node.home, "command-hook.sh"), 'echo forbidden > "$HOME/hook-ran"\n');
    writeFileSync(
      join(node.home, rc),
      [
        'printf "startup\\n" >> "$HOME/startups"',
        "echo startup-output-must-not-be-command-output",
        "private_scalar='private startup'",
        "private_array=('array zero' 'array one')",
        "typeset -ax public_array=('exported zero' 'exported one')",
        "readonly fixed='readonly startup'",
        "BASH_CUSTOM='ordinary variable'",
        "export PUBLIC_VALUE='export startup'",
        'export BASH_ENV="$HOME/command-hook.sh" ENV="$HOME/command-hook.sh"',
        "unset REMOVED",
        shell === "bash"
          ? "export -n PRIVATE; shopt -s nullglob extglob"
          : "typeset +x PRIVATE; setopt nullglob",
        "alias startup_alias='printf \"alias startup\\n\"'",
        `startup_function() { printf '%s|%s|%s|%s|%s|%s\\n' "$private_scalar" "\${private_array[${shell === "bash" ? 0 : 1}]}" "$PUBLIC_VALUE" "$fixed" "$BASH_CUSTOM" "\${public_array[${shell === "bash" ? 0 : 1}]}"; }`,
        shell === "bash"
          ? 'extended() { case "$1" in +(a)) echo extended;; esac; }'
          : "extended() { echo extended; }",
        "IFS=:; set -u; cd /",
      ].join("\n"),
    );
    const inspect =
      'startup_alias; startup_function; extended aaa; printf \'%s\\n\' "$HOME" "$PWD"; ' +
      (shell === "bash" ? "shopt -q nullglob" : "[[ -o nullglob ]]") +
      " && echo option; env | sort";
    const first = await node.run(agentId, "bash", { command: inspect });
    expect(first.isError, textOf(first)).toBe(false);
    expect(first.content[0]?.text).toContain(
      "private startup|array zero|export startup|readonly startup|ordinary variable|exported zero",
    );
    expect(first.content[0]?.text).toContain(`alias startup\n`);
    expect(first.content[0]?.text).toContain(`extended\n${node.home}\n${workspace}\noption`);
    expect(first.content[0]?.text).not.toContain("startup-output");
    expect(first.content[0]?.text).not.toMatch(/(?:REMOVED|PRIVATE)=/);
    await node.run(agentId, "bash", {
      command:
        "private_scalar=changed; private_array=(changed); export PUBLIC_VALUE=changed; unset -f startup_function; unalias startup_alias; IFS=changed",
    });
    writeFileSync(join(node.home, rc), "exit 9\n");
    const again = await node.run(agentId, "bash", { command: inspect });
    expect(again.isError, textOf(again)).toBe(false);
    expect(again.content[0]?.text).toBe(first.content[0]?.text);
    expect(readFileSync(join(node.home, "startups"), "utf8")).toBe("startup\n");
    expect(existsSync(join(node.home, "hook-ran"))).toBe(false);
    const other = await node.agent();
    const shared = await node.run(other.agentId, "bash", { command: inspect });
    expect(shared.content[0]?.text).toBe(
      first.content[0]?.text.replaceAll(workspace, other.workspace),
    );
    expect(readFileSync(join(node.home, "startups"), "utf8")).toBe("startup\n");
  });

  it("keeps startup variables absent when the interpreter supplies its own defaults", async () => {
    const node = await connectedNode();
    const { agentId } = await node.agent();
    writeFileSync(
      join(node.home, rc),
      'unset PATH\nstartup_path() { printf "PATH=%s\\n" "${PATH-absent}"; }\n',
    );
    for (let call = 0; call < 2; call++) {
      const result = await node.run(agentId, "bash", {
        command: "startup_path; export PATH=/usr/bin:/bin",
      });
      expect(result.isError, textOf(result)).toBe(false);
      expect(result.content[0]?.text).toBe("PATH=absent\n");
    }
  });

  it("preserves private startup values without exporting the interpreter's default variables", async () => {
    const node = await connectedNode({ env: { LOGNAME: "startup-account" } });
    const { agentId } = await node.agent();
    writeFileSync(
      join(node.home, rc),
      [
        shell === "bash" ? "export -n HOME LOGNAME" : "typeset +x HOME LOGNAME",
        'private_defaults() { printf "%s|%s\\n" "$HOME" "$LOGNAME"; /usr/bin/env; }',
      ].join("\n"),
    );
    for (let call = 0; call < 2; call++) {
      const result = await node.run(agentId, "bash", {
        command: "private_defaults; export HOME=/changed LOGNAME=changed",
      });
      expect(result.isError, textOf(result)).toBe(false);
      expect(result.content[0]?.text).toContain(`${node.home}|startup-account\n`);
      expect(result.content[0]?.text).not.toMatch(/^(?:HOME|LOGNAME)=/m);
    }
  });

  it("restores startup PATH for actual command lookup in every fresh process", async () => {
    const node = await connectedNode();
    const { agentId } = await node.agent();
    const bin = join(node.home, "custom-bin");
    mkdirSync(bin);
    const executable = join(bin, "startup-executable");
    writeFileSync(executable, "#!/bin/sh\nprintf 'custom command\\n'\n");
    chmodSync(executable, 0o755);
    writeFileSync(
      join(node.home, rc),
      `export PATH=${quote(bin)}\nstartup_lookup() { startup-executable; }\n`,
    );
    for (let call = 0; call < 2; call++) {
      const result = await node.run(agentId, "bash", {
        command: "startup_lookup; unset PATH",
      });
      expect(result.isError, textOf(result)).toBe(false);
      expect(result.content[0]?.text).toBe("custom command\n");
    }
  });

  it("keeps source setup within one call and records a physical directory even on nonzero completion", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    const directory = join(workspace, "space and\nnewline\n");
    mkdirSync(directory);
    writeFileSync(join(workspace, "setup.sh"), "export CALL_ONLY=available\n");
    const setup = await node.run(agentId, "bash", {
      command: "source setup.sh && printf '%s' \"$CALL_ONLY\"",
    });
    expect(setup.content[0]?.text).toBe("available");
    const changed = await node.run(agentId, "bash", { command: `cd ${quote(directory)}; false` });
    expect(changed.isError).toBe(true);
    expect(textOf(changed)).toContain("Command exited with code 1");
    expect(textOf(changed)).toContain(directory);
    const next = await node.run(agentId, "bash", {
      command: 'printf \'%s|%s\' "$PWD" "${CALL_ONLY-absent}"',
    });
    expect(textOf(next)).toBe(`${directory}|absent`);
    const file = await node.run(agentId, "read", { path: "setup.sh" });
    expect(textOf(file)).toBe("export CALL_ONLY=available\n");
    const outside = temporaryDirectory();
    await node.run(agentId, "bash", { command: `cd ${quote(outside)}` });
    expect(textOf(await node.run(agentId, "bash", { command: "printf '%s' \"$PWD\"" }))).toBe(
      outside,
    );
  });

  it("preserves startup errexit and keeps the previous directory when it terminates the shell before reporting", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    writeFileSync(join(node.home, rc), "set -e\n");
    const result = await node.run(agentId, "bash", { command: "cd /; false; echo must-not-run" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Command exited with code 1");
    expect(textOf(result)).not.toContain("must-not-run");
    expect(textOf(await node.run(agentId, "bash", { command: "printf '%s' \"$PWD\"" }))).toBe(
      workspace,
    );
  });

  it("restores ordinary options while leaving terminal and startup-file options owned by execution", async () => {
    const node = await connectedNode();
    const { agentId } = await node.agent();
    writeFileSync(
      join(node.home, rc),
      shell === "bash"
        ? "set -o emacs; set +o interactive-comments\n"
        : "setopt emacs; unsetopt interactivecomments\n",
    );
    const command =
      "[[ ! -o emacs && ! -o vi && ! -o monitor ]] && echo terminal-off; " +
      (shell === "bash"
        ? "[[ ! -o interactive-comments ]]"
        : "[[ ! -o interactivecomments && -o norcs && -o noglobalrcs ]]") +
      " && echo configuration-restored";
    const result = await node.run(agentId, "bash", { command });
    expect(result.isError, textOf(result)).toBe(false);
    expect(result.content[0]?.text).toBe("terminal-off\nconfiguration-restored\n");
  });

  it.skipIf(shell !== "zsh")(
    "respects ZDOTDIR and restores fpath, autoload and module dependencies without reloading rc",
    async () => {
      const dotdir = temporaryDirectory();
      const functions = join(dotdir, "functions");
      mkdirSync(functions);
      writeFileSync(
        join(functions, "startup_autoload"),
        'printf "%s\\n" "$private_value"\nzstat +size -- "$HOME/module-data"\n',
      );
      writeFileSync(
        join(dotdir, ".zshrc"),
        `zmodload zsh/stat; private_value='autoload startup'; fpath=(${quote(functions)} $fpath); autoload -Uz startup_autoload\n`,
      );
      const node = await connectedNode({ env: { ZDOTDIR: dotdir } });
      const { agentId } = await node.agent();
      writeFileSync(join(node.home, "module-data"), "abc");
      const first = await node.run(agentId, "bash", { command: "startup_autoload" });
      expect(first.isError, textOf(first)).toBe(false);
      expect(first.content[0]?.text).toBe("autoload startup\n3\n");
      writeFileSync(join(dotdir, ".zshrc"), "exit 9\n");
      const again = await node.run(agentId, "bash", { command: "startup_autoload" });
      expect(again.isError, textOf(again)).toBe(false);
      expect(again.content[0]?.text).toBe("autoload startup\n3\n");
    },
  );

  it("bounds an oversized startup baseline and does not run the requested command", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    writeFileSync(join(node.home, rc), "large_value=$(printf '%*s' 4194304 '')\n");
    const result = await node.run(agentId, "bash", { command: "touch forbidden" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("4 MiB");
    expect(existsSync(join(workspace, "forbidden"))).toBe(false);
  });

  it("keeps the previous directory when exit, exec or a signal ends the shell, without changing their outcomes", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    for (const [command, isError] of [
      ["cd /; exit 7", true],
      ["cd /; exec /usr/bin/true", false],
      ["cd /; kill -TERM $$", true],
    ] as const) {
      const result = await node.run(agentId, "bash", { command });
      expect(result.isError, textOf(result)).toBe(isError);
      expect(textOf(result)).not.toContain("Working directory");
      expect(textOf(await node.run(agentId, "bash", { command: "printf '%s' \"$PWD\"" }))).toBe(
        workspace,
      );
    }
  });

  it("uses private cwd metadata despite output redirection and background descriptor holders", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    const directory = join(workspace, "project");
    mkdirSync(directory);
    const result = await node.run(agentId, "bash", {
      command: "cd project; sleep 30 >/dev/null 2>&1 & exec >/dev/null 2>&1; false",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Command exited with code 1");
    expect(textOf(await node.run(agentId, "bash", { command: "printf '%s' \"$PWD\"" }))).toBe(
      directory,
    );
  });

  it("starts in the workspace when the remembered directory is gone, and still requires the workspace", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    const directory = join(workspace, "removed");
    mkdirSync(directory);
    await node.run(agentId, "bash", { command: "cd removed" });
    rmSync(directory, { recursive: true });
    const fallback = await node.run(agentId, "bash", { command: "pwd" });
    expect(fallback.isError, textOf(fallback)).toBe(false);
    expect(fallback.content[0]?.text).toBe(`${workspace}\n`);
    expect(textOf(fallback)).toContain(`${directory} no longer exists`);
    rmSync(workspace, { recursive: true });
    const noWorkspace = await node.run(agentId, "bash", { command: "echo forbidden" });
    expect(noWorkspace.isError).toBe(true);
    expect(textOf(noWorkspace)).toContain("prepare the workspace again");
  });

  it("starts overlapping calls from the remembered directory and keeps the one that finishes last", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    for (const name of ["first", "last"]) mkdirSync(join(workspace, name));
    const first = node.run(agentId, "bash", { command: `cd first; ${longCommand("first")}` });
    await pidsOf(join(workspace, "first"), "first");
    const last = node.run(agentId, "bash", { command: `cd last; ${longCommand("last")}` });
    await pidsOf(join(workspace, "last"), "last");
    writeFileSync(join(workspace, "first", "first.go"), "");
    expect((await first).isError).toBe(false);
    writeFileSync(join(workspace, "last", "last.go"), "");
    expect((await last).isError).toBe(false);
    expect(textOf(await node.run(agentId, "bash", { command: "printf '%s' \"$PWD\"" }))).toBe(
      join(workspace, "last"),
    );
  });

  it("remembers a directory per conversation, which background calls start from but never change", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    const project = join(workspace, "project");
    mkdirSync(project);
    const run = (conversationId: number, command: string, background = false) =>
      node.run(agentId, "bash", { command, background }, undefined, "home", conversationId);
    await run(1, "cd project");
    const background = await run(1, "pwd; cd /", true);
    expect(background.content[0]?.text).toBe(`${project}\n`);
    expect(textOf(background)).not.toContain("Working directory");
    expect((await run(2, "pwd; cd /")).content[0]?.text).toBe(`${workspace}\n`);
    expect(textOf(await run(1, "printf '%s' \"$PWD\""))).toBe(project);
    expect(textOf(await run(2, "printf '%s' \"$PWD\""))).toBe("/");
    const other = await node.agent();
    expect((await node.run(other.agentId, "bash", { command: "pwd" })).content[0]?.text).toBe(
      `${other.workspace}\n`,
    );
    const before = node.gateway.authentications;
    node.gateway.disconnect();
    await eventually(() => node.gateway.authentications > before, "node reconnected");
    expect(textOf(await run(1, "printf '%s' \"$PWD\""))).toBe(project);
  });

  it("does not repeat failed startup side effects until the node restarts", async () => {
    const node = await connectedNode();
    const { agentId } = await node.agent();
    writeFileSync(join(node.home, rc), 'echo attempted >> "$HOME/attempts"; exit 9\n');
    for (let i = 0; i < 2; i++) {
      const result = await node.run(agentId, "bash", { command: "echo forbidden" });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Restart the node");
      expect(textOf(result)).not.toContain("forbidden");
      writeFileSync(join(node.home, rc), "echo fixed\n");
    }
    expect(readFileSync(join(node.home, "attempts"), "utf8")).toBe("attempted\n");
    await node.shutdown();
    const restarted = await connectedNode({ home: node.home, gateway: node.gateway });
    const retried = await restarted.run(agentId, "bash", { command: "echo recovered" });
    expect(retried.isError, textOf(retried)).toBe(false);
    expect(retried.content[0]?.text).toBe("recovered\n");
  });

  it("starts at the workspace after node restart and reloads startup configuration", async () => {
    const node = await connectedNode();
    const { agentId, workspace } = await node.agent();
    writeFileSync(join(node.home, rc), "export STARTUP=before\n");
    mkdirSync(join(workspace, "project"));
    await node.run(agentId, "bash", { command: "cd project" });
    writeFileSync(join(node.home, rc), "export STARTUP=after\n");
    await node.shutdown();
    const restarted = await connectedNode({ home: node.home, gateway: node.gateway });
    const result = await restarted.run(agentId, "bash", {
      command: 'printf \'%s|%s\' "$PWD" "$STARTUP"',
    });
    expect(result.content[0]?.text).toBe(`${workspace}|after`);
  });

  it("keeps capturing startup for other callers, and for later ones, when its waiters stop", async () => {
    const node = await connectedNode();
    const { agentId } = await node.agent();
    writeFileSync(
      join(node.home, rc),
      `echo started >> "$HOME/startups"; while [ ! -e "$HOME/startup.go" ]; do sleep 0.02; done\n`,
    );
    const first = node.gateway.runTool("first", agentId, "bash", { command: "echo first" });
    const second = node.run(agentId, "bash", { command: "echo second" });
    await eventually(() => existsSync(join(node.home, "startups")), "startup began");
    node.gateway.stopTool("first");
    expect((await first).isError).toBe(true);
    writeFileSync(join(node.home, "startup.go"), "");
    expect((await second).content[0]?.text).toBe("second\n");

    const alone = await connectedNode();
    const lone = await alone.agent();
    writeFileSync(
      join(alone.home, rc),
      `echo started >> "$HOME/startups"; while [ ! -e "$HOME/startup.go" ]; do sleep 0.02; done\n`,
    );
    const stopped = alone.gateway.runTool("alone", lone.agentId, "bash", { command: "echo no" });
    await eventually(() => existsSync(join(alone.home, "startups")), "second startup began");
    alone.gateway.stopTool("alone");
    expect((await stopped).isError).toBe(true);
    writeFileSync(join(alone.home, "startup.go"), "");
    const later = await alone.run(lone.agentId, "bash", { command: "echo later" });
    expect(later.content[0]?.text).toBe("later\n");
    expect(readFileSync(join(alone.home, "startups"), "utf8")).toBe("started\n");
  });
});
