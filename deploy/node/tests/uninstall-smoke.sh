#!/bin/sh
# Actual bundle CLI and user manager; synthetic external WebSocket peer only.
# Run in an explicitly authorized disposable Linux host/VM ordinary account.
set -eu
[ "$#" -eq 6 ] || { echo 'Usage: uninstall-smoke.sh ARCHIVE BOOTSTRAP SHA VERSION PEER_SCRIPT CUT_SCRIPT' >&2; exit 2; }
archive=$1 bootstrap=$2 checksum=$3 version=$4 peer_script=$5 cut_script=$6
[ "$(id -u)" != 0 ] || { echo 'Use the existing ordinary test account' >&2; exit 1; }
[ "$(systemd-detect-virt --container 2>/dev/null || true)" = none ] || { echo 'Containers do not establish service acceptance' >&2; exit 1; }
command -v node >/dev/null 2>&1 && { echo 'Host Node must not supplement the package' >&2; exit 1; }
entry="$HOME/.local/bin/mate" unit="$HOME/.config/systemd/user/mate-node.service"
config="$HOME/.config/mate/node.json" data="$HOME/.local/share/mate/node"
for path in "$entry" "$unit" "$config" "$data" "$HOME/.local/lib/mate-node"; do
  [ ! -e "$path" ] && [ ! -L "$path" ] || { echo "Refusing existing Mate files: $path" >&2; exit 1; }
done
work=$(mktemp -d)
phase=bootstrap peer_pid= cli_pid= observer_pid=
cleanup() {
  result=$?
  if [ "$result" != 0 ]; then
    printf 'MATE_UNINSTALL_SMOKE_FAIL phase=%s exit=%s evidence=%s\n' "$phase" "$result" "$work" >&2
    for file in "$work"/*.log; do [ ! -f "$file" ] || { printf 'Evidence: %s\n' "$file" >&2; cat "$file" >&2; }; done
  fi
  if [ -n "$observer_pid" ]; then kill "$observer_pid" 2>/dev/null || true; wait "$observer_pid" 2>/dev/null || true; fi
  if [ -n "$cli_pid" ] && [ -n "${recovery_runtime:-}" ]; then
    "$recovery_runtime" --input-type=module -e '
      import {readFileSync} from "node:fs";
      const pid=Number(process.argv[1]), parent=Number(process.argv[2]);
      if(!Number.isSafeInteger(pid) || pid<=1) throw new Error("Refusing unsafe cleanup PID");
      try {
        const own=readFileSync(`/proc/${pid}/status`,"utf8");
        if(Number(own.match(/^PPid:\s+(\d+)/m)?.[1])!==parent || Number(own.match(/^Uid:\s+(\d+)/m)?.[1])!==process.getuid()) throw new Error("Cleanup CLI ownership changed; preserved");
        const children=readFileSync(`/proc/${pid}/task/${pid}/children`,"utf8").trim().split(/\s+/).filter(Boolean).map(Number);
        for(const child of children) {
        if(!Number.isSafeInteger(child)||child<=1) throw new Error("Unsafe cleanup child");
        try {
          const status=readFileSync(`/proc/${child}/status`,"utf8");
          if(Number(status.match(/^PPid:\s+(\d+)/m)?.[1])!==pid || Number(status.match(/^Uid:\s+(\d+)/m)?.[1])!==process.getuid()) throw new Error("Cleanup child ownership changed; preserved");
          process.kill(child,"SIGKILL");
        } catch(error) {if(!["ENOENT","ESRCH"].includes(error.code))throw error;}
        }
        process.kill(pid,"SIGKILL");
      } catch(error) {if(!["ENOENT","ESRCH"].includes(error.code))throw error;}
    ' "$cli_pid" "$$" || { echo 'Owned CLI child cleanup failed; evidence retained' >&2; }
  fi
  if [ -n "$cli_pid" ]; then wait "$cli_pid" 2>/dev/null || true; fi
  if [ -n "$peer_pid" ]; then kill "$peer_pid" 2>/dev/null || true; wait "$peer_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
printf 'Evidence: OS=%s arch=%s UID=%s GID=%s virtualization=%s manager=%s linger=%s\n' \
  "$(. /etc/os-release; printf '%s:%s' "$ID" "$VERSION_ID")" "$(uname -m)" "$(id -u)" "$(id -g)" \
  "$(systemd-detect-virt)" "$(systemctl --user show --property=Version --value)" "$(loginctl show-user "$(id -u)" --property=Linger --value)"
printf 'Protocol peer is synthetic; this is not control-plane/provider integration.\n'
sh "$bootstrap" --version "$version" --package "$archive" --sha256 "$checksum"
bundle="$HOME/.local/lib/mate-node/versions/$version"
runtime="$bundle/node/bin/node"
"$runtime" "$peer_script" "$bundle" "$work" >"$work/peer.log" 2>&1 & peer_pid=$!
i=0
until grep -q MATE_TEST_PEER_READY "$work/peer.log"; do i=$((i+1)); [ "$i" -lt 100 ] || exit 1; sleep .1; done
mkdir -p "$HOME/.config/mate"; chmod 700 "$HOME/.config/mate"
printf '{"MATE_CONTROL_PLANE_URL":"http://127.0.0.1:18789","MATE_NODE_PAIRING_TOKEN":"mate-service-synthetic-valid-token-0000000000"}\n' >"$config"; chmod 600 "$config"
phase=pair-and-retain
"$entry" node install >"$work/install.log" 2>&1
i=0
until journalctl --user --unit mate-node.service --no-pager | grep -q MATE_NODE_PAIRED; do i=$((i+1)); [ "$i" -lt 60 ] || exit 1; sleep 1; done
mkdir -p "$data/agents" "$data/workspace-receipts"
printf 'synthetic retained memory\n' >"$data/agents/MEMORY.md"
printf 'synthetic retained receipt\n' >"$data/workspace-receipts/uninstall-fixture.json"
identity_sha=$(sha256sum "$data/node-identity.json" | cut -d' ' -f1)
config_sha=$(sha256sum "$config" | cut -d' ' -f1)
memory_sha=$(sha256sum "$data/agents/MEMORY.md" | cut -d' ' -f1)
receipt_sha=$(sha256sum "$data/workspace-receipts/uninstall-fixture.json" | cut -d' ' -f1)
printf '%s  %s\n' "$checksum" "$archive" | sha256sum -c -
mkdir "$work/recovery"; tar -xzf "$archive" -C "$work/recovery"
recovery="$work/recovery/mate-node"
recovery_runtime="$recovery/node/bin/node" recovery_cli="$recovery/app/apps/node/dist/management/cli.js"
[ "$("$recovery_runtime" "$recovery_cli" --version)" = "$version" ]
phase=foreign-unit
cp "$unit" "$work/unit.saved"
printf '[Service]\nExecStart=/non-mate-test-fixture\n' >"$unit"
if "$entry" node uninstall >"$work/foreign-unit.log" 2>&1; then exit 1; fi
grep -q Non-Mate "$work/foreign-unit.log"; grep -q /non-mate-test-fixture "$unit"
mv "$work/unit.saved" "$unit"
phase=foreign-entry
mv "$entry" "$work/entry.saved"; printf 'non-Mate command\n' >"$entry"
if "$recovery_runtime" "$recovery_cli" node uninstall >"$work/foreign-entry.log" 2>&1; then exit 1; fi
grep -q Non-Mate "$work/foreign-entry.log"; grep -q 'non-Mate command' "$entry"
rm "$entry"; mv "$work/entry.saved" "$entry"
phase=actual-sigkill
"$entry" node uninstall >"$work/interrupted.log" 2>&1 & cli_pid=$!
killed=no
while kill -0 "$cli_pid" 2>/dev/null; do
  if [ ! -e "$unit" ]; then kill -KILL "$cli_pid"; killed=yes; break; fi
done
[ "$killed" = yes ] || { echo 'No live uninstall interruption point observed' >&2; exit 1; }
if wait "$cli_pid"; then exit 1; fi
cli_pid=
[ -f "$bundle/bundle.json" ] || { echo 'Uninstall already completed before SIGKILL; no recovery evidence established' >&2; exit 1; }
printf 'Observed live uninstall SIGKILL with remaining owned bundle inventory: %s\n' "$bundle/bundle.json"
# Prepare the explicitly requested unavailable-public-entry recovery case; never reinstall/start.
if [ -L "$entry" ]; then rm "$entry"; fi
phase=local-bundle-recovery
"$recovery_runtime" "$recovery_cli" node uninstall >"$work/recovery.log" 2>&1
"$recovery_runtime" "$recovery_cli" node uninstall >"$work/repeat.log" 2>&1
[ ! -e "$entry" ] && [ ! -L "$entry" ] && [ ! -e "$unit" ] && [ ! -d "$bundle" ]
[ "$(systemctl --user show mate-node.service --property=LoadState --value)" = not-found ]
grep -q Preserved "$work/recovery.log"
check_retained() {
  [ "$(sha256sum "$data/node-identity.json" | cut -d' ' -f1)" = "$identity_sha" ]
  [ "$(sha256sum "$config" | cut -d' ' -f1)" = "$config_sha" ]
  [ "$(sha256sum "$data/agents/MEMORY.md" | cut -d' ' -f1)" = "$memory_sha" ]
  [ "$(sha256sum "$data/workspace-receipts/uninstall-fixture.json" | cut -d' ' -f1)" = "$receipt_sha" ]
}
check_retained
phase=reinstall-same-identity
sh "$bootstrap" --version "$version" --package "$archive" --sha256 "$checksum"
"$entry" node install >"$work/reinstall.log" 2>&1
"$entry" node stop >"$work/stop.log" 2>&1
check_retained
phase=normal-self-uninstall
"$entry" node uninstall >"$work/self-uninstall.log" 2>&1
[ ! -e "$entry" ] && [ ! -L "$entry" ] && [ ! -e "$unit" ] && [ ! -d "$bundle" ]
check_retained
cut_timeout=${MATE_TEST_CUT_TIMEOUT_SECONDS:-180}
case "$cut_timeout" in ''|*[!0-9]*) echo 'Invalid cut timeout' >&2; exit 1;; esac
[ "$cut_timeout" -ge 1 ] && [ "$cut_timeout" -le 1800 ] || exit 1
cut_update_and_uninstall() {
  cut_phase=$1 update_version=$2 update_archive=$3 update_sha=$4
  rm -f "$work/cut.json" "$work/cut.ready" "$work/cut.pid"
  MATE_TEST_CUT_TIMEOUT_SECONDS="$cut_timeout" "$recovery_runtime" "$cut_script" "$entry" "$unit" "$update_version" "$work/cut.pid" "$work/cut.ready" "$work/cut.json" "$cut_phase" >"$work/cut-$cut_phase.log" 2>&1 & observer_pid=$!
  i=0
  until [ -f "$work/cut.ready" ]; do i=$((i+1)); [ "$i" -lt 100 ] || exit 1; sleep .1; done
  "$recovery_runtime" "$recovery_cli" node update --version "$update_version" --package "$update_archive" --sha256 "$update_sha" >"$work/update-$cut_phase.log" 2>&1 & cli_pid=$!
  printf '%s\n' "$cli_pid" >"$work/cut.pid"
  i=0
  until [ -f "$work/cut.json" ]; do
    kill -0 "$observer_pid" 2>/dev/null || { wait "$observer_pid"; exit 1; }
    i=$((i+1)); [ "$i" -lt "$((cut_timeout*10+100))" ] || exit 1; sleep .1
  done
  wait "$observer_pid"; observer_pid=
  # Confirm the observed owned residual still exists after SIGSTOP; do not count a past cut.
  "$recovery_runtime" --input-type=module -e '
    import {existsSync,readFileSync,readdirSync,writeFileSync} from "node:fs";
    import {dirname,join} from "node:path";
    const cut=JSON.parse(readFileSync(process.argv[1],"utf8")), pid=Number(process.argv[2]), unit=process.argv[3];
    if(cut.pid!==pid || !Number.isSafeInteger(pid) || pid<=1 || !/^State:\s+T/m.test(readFileSync(`/proc/${pid}/status`,"utf8"))) throw new Error("Actual update CLI is not paused at owned cut");
    if(cut.phase==="unit-moved" && (existsSync(unit) || !readdirSync(dirname(unit)).some(name=>name.startsWith(".mate-node-previous-unit-")))) throw new Error("Canonical unit is not missing with a remaining moved owned unit");
    if(cut.phase==="install" && (!existsSync(join(cut.installationEvidence.stage,".mate-install-stage")) || !existsSync(join(cut.installationEvidence.stage,"app/apps/node/dist/main.js")))) throw new Error("No remaining actual copy stage");
    if(cut.phase==="repair-cleanup" && (!existsSync(join(cut.repairEvidence.backup,"bundle.json")) || existsSync(join(cut.repairEvidence.backup,cut.repairEvidence.missingPayload)))) throw new Error("No remaining partial owned repair inventory");
    for(const child of cut.children) {if(!Number.isSafeInteger(child)||child<=1)throw new Error("Unsafe child PID");try {process.kill(child,"SIGKILL");}catch(error){if(error.code!=="ESRCH")throw error;}}
    process.kill(pid,"SIGKILL");
    if(cut.repairEvidence)writeFileSync(process.argv[4],cut.repairEvidence.backup);
    if(cut.installationEvidence)writeFileSync(process.argv[4],cut.installationEvidence.stage);
    console.log("Verified actual owned cut:",JSON.stringify(cut));
  ' "$work/cut.json" "$cli_pid" "$unit" "$work/stage-path"
  mv "$work/cut.json" "$work/cut-$cut_phase.json"
  if wait "$cli_pid"; then exit 1; fi
  cli_pid=
  uninstall_runtime=$recovery_runtime uninstall_cli=$recovery_cli
  if [ "$cut_phase" = install ]; then
    uninstall_runtime="$work/new-package/mate-node/node/bin/node"
    uninstall_cli="$work/new-package/mate-node/app/apps/node/dist/management/cli.js"
    [ "$("$uninstall_runtime" "$uninstall_cli" --version)" = "$update_version" ]
  fi
  if [ "$cut_phase" = repair-cleanup ] || [ "$cut_phase" = install ]; then
    staged=$(cat "$work/stage-path")
    printf 'unknown test file\n' >"$staged/non-mate-fixture"
    if "$uninstall_runtime" "$uninstall_cli" node uninstall >"$work/$cut_phase-foreign.log" 2>&1; then exit 1; fi
    grep -q 'Unknown' "$work/$cut_phase-foreign.log"
    grep -q 'unknown test file' "$staged/non-mate-fixture"
    rm "$staged/non-mate-fixture"
  fi
  "$uninstall_runtime" "$uninstall_cli" node uninstall >"$work/uninstall-$cut_phase.log" 2>&1
  [ ! -e "$unit" ] && [ ! -e "$bundle" ] && [ ! -L "$entry" ]
  for path in "$HOME/.local/lib/mate-node/versions"/.install-* "$HOME/.local/lib/mate-node/versions"/.repair-* "$HOME/.config/systemd/user"/.mate-node-previous-unit-* "$HOME/.config/systemd/user"/.mate-node-unit-*; do [ ! -e "$path" ]; done
  check_retained
}
phase=uninstall-from-update-unit-cut
sh "$bootstrap" --version "$version" --package "$archive" --sha256 "$checksum"
"$entry" node install >"$work/unit-cut-install.log" 2>&1
"$entry" node stop >"$work/unit-cut-stop.log" 2>&1
cut_update_and_uninstall unit-moved "$version" "$archive" "$checksum"
phase=uninstall-from-update-install-cut
sh "$bootstrap" --version "$version" --package "$archive" --sha256 "$checksum"
"$entry" node install >"$work/copy-cut-install.log" 2>&1
"$entry" node stop >"$work/copy-cut-stop.log" 2>&1
mkdir "$work/new-package"; tar -xzf "$archive" -C "$work/new-package"
next_version="$version-uninstall-cut"
"$recovery_runtime" --input-type=module -e 'import {readFileSync,writeFileSync} from "node:fs";const file=process.argv[1],metadata=JSON.parse(readFileSync(file,"utf8"));metadata.version=process.argv[2];writeFileSync(file,JSON.stringify(metadata)+"\n");' "$work/new-package/mate-node/bundle.json" "$next_version"
tar -czf "$work/new-package.tar.gz" -C "$work/new-package" mate-node
next_sha=$(sha256sum "$work/new-package.tar.gz" | cut -d' ' -f1)
cut_update_and_uninstall install "$next_version" "$work/new-package.tar.gz" "$next_sha"
phase=uninstall-from-update-repair-cut
sh "$bootstrap" --version "$version" --package "$archive" --sha256 "$checksum"
"$entry" node install >"$work/repair-cut-install.log" 2>&1
"$entry" node stop >"$work/repair-cut-stop.log" 2>&1
printf 'synthetic installed-program corruption\n' >"$bundle/app/apps/node/dist/management/cli.js"
cut_update_and_uninstall repair-cleanup "$version" "$archive" "$checksum"
printf 'MATE_UNINSTALL_SMOKE_PASS %s evidence=%s\n' "$version" "$work"
