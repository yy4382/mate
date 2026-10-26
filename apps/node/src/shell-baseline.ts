export type AccountShell = { executable: string; family: "bash" | "zsh" };

function forEachVariable(family: AccountShell["family"], command: string): string {
  // Expand zsh's parameter metadata before cleanup can unset its module search path.
  return family === "bash"
    ? String.raw`
while IFS= builtin read -r __mate_name; do
  case "$__mate_name" in BASH|BASH_ALIASES|BASH_ARGC|BASH_ARGV|BASH_ARGV0|BASH_CMDS|BASH_COMMAND|BASH_EXECUTION_STRING|BASH_LINENO|BASH_MONOSECONDS|BASH_REMATCH|BASH_SOURCE|BASH_SUBSHELL|BASH_VERSINFO|BASH_VERSION|BASH_XTRACEFD|BASHOPTS|BASHPID|COMP_WORDBREAKS|COPROC|EPOCHREALTIME|EPOCHSECONDS|EUID|UID|PPID|SHELLOPTS|FUNCNAME|GROUPS|DIRSTACK|HISTCMD|PIPESTATUS|LINENO|RANDOM|SRANDOM|SECONDS|_|PWD|OLDPWD|SHLVL|__mate_*) continue;; esac
  ${command}
done < <(builtin compgen -v)
`
    : String.raw`
for __mate_name __mate_type in "@@{(@kv)parameters}"; do
  [[ $__mate_type == *special* && ( $__mate_type == *readonly* || $__mate_type == *hide* ) ]] && continue
  case "$__mate_name" in RANDOM|SECONDS|UID|EUID|GID|EGID|USERNAME|0|argv|pipestatus|_|SHLVL|OPTIND|OPTARG|TRY_BLOCK_ERROR|TRY_BLOCK_INTERRUPT|LINES|COLUMNS|watch|WATCH|ZSH_EXECUTION_STRING|ZSH_ARGZERO|PWD|OLDPWD|__mate_*) continue;; esac
  ${command}
done
`.replaceAll("@@", "$");
}

const bashCapture = String.raw`
builtin set +o >&3
builtin printf '\0' >&3
builtin shopt -p >&3 || :
builtin printf '\0' >&3
builtin set +e +u +x +v
${forEachVariable("bash", 'builtin declare -p "$__mate_name" >&3')}
builtin declare -f >&3
builtin alias -p >&3
builtin printf '\0' >&3
`;

const zshCapture = String.raw`
builtin set +o >&3
builtin printf '\0' >&3
builtin set +e +u +x +v
builtin zmodload -L >&3
builtin printf '\0' >&3
${forEachVariable("zsh", 'builtin typeset -p "$__mate_name" >&3')}
builtin functions >&3
builtin alias -L >&3
builtin printf '\0' >&3
`;

const invocationOptions = new Set([
  "interactive",
  "monitor",
  "zle",
  "singlelinezle",
  "emacs",
  "vi",
  "stdin",
  "shinstdin",
  "login",
  "restricted",
  "privileged",
  "singlecommand",
  "onecmd",
  "exec",
  "rcs",
  "globalrcs",
]);

export function startupCapture(shell: AccountShell) {
  return {
    executable: shell.executable,
    args: ["-ic", shell.family === "bash" ? bashCapture : zshCapture],
    metadata: { frames: 3, maxBytes: 4 * 1024 * 1024 },
  };
}

export function restoreSource(shell: AccountShell, metadata: Buffer): Buffer {
  const parts = metadata.toString("utf8").split("\0");
  const options = (parts[0] ?? "")
    .split("\n")
    .filter((line) => {
      const match = /^set [-+]o ([\w-]+)$/.exec(line);
      if (match === null) return false;
      const name = match[1]!.replaceAll(/[_-]/g, "");
      return !invocationOptions.has(name) && !invocationOptions.has(name.replace(/^no/, ""));
    })
    .map((line) => `builtin ${line}`)
    .join("\n");
  // Zsh special parameters retain export attributes across unset.
  const reset = forEachVariable(
    shell.family,
    shell.family === "bash"
      ? 'builtin unset -v "$__mate_name"'
      : 'builtin typeset +x "$__mate_name"; builtin unset -v "$__mate_name"',
  );
  // Bash set +o posix can reset shopt flags. Zsh modules need their search path before reset.
  return Buffer.from(
    shell.family === "bash"
      ? `${reset}\n${parts[2]}\n${options}\n${parts[1]}\n`
      : `${parts[1]}\n${reset}\n${parts[2]}\n${options}\n`,
  );
}

export function commandReplay(shell: AccountShell, source: Buffer, command: string) {
  // Bash must enable extglob before eval parses the captured function bodies.
  const wrapper = String.raw`
IFS= builtin read -r -d '' __mate_restore <&4 || :
builtin set -e
${shell.family === "bash" ? "builtin shopt -s extglob" : ""}
builtin eval "$__mate_restore"
builtin unset __mate_restore
builtin eval "$1"
__mate_status=$?
builtin pwd -P >&3 && builtin printf '\0' >&3
builtin exit "$__mate_status"
`;
  return {
    executable: shell.executable,
    args: [
      ...(shell.family === "bash" ? ["--noprofile", "--norc"] : ["-df"]),
      "-c",
      wrapper,
      shell.executable,
      command,
    ],
    input: source,
    metadata: { frames: 1, maxBytes: 64 * 1024 },
  };
}
