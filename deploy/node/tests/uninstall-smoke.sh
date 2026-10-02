#!/bin/sh
# Actual bundle CLI and user manager; synthetic external WebSocket peer only.
# Run in an explicitly authorized disposable Linux host/VM ordinary account.
set -eu
archive=$1 bootstrap=$2 checksum=$3 version=$4 peer_script=$5
[ "$(id -u)" != 0 ] || { echo 'Use the existing ordinary test account' >&2; exit 1; }
[ "$(systemd-detect-virt --container 2>/dev/null || true)" = none ] || { echo 'Containers do not establish service acceptance' >&2; exit 1; }
command -v node >/dev/null 2>&1 && { echo 'Host Node must not supplement the package' >&2; exit 1; }
entry="$HOME/.local/bin/mate" unit="$HOME/.config/systemd/user/mate-node.service"
config="$HOME/.config/mate/node.json" data="$HOME/.local/share/mate/node"
for path in "$entry" "$unit" "$config" "$data" "$HOME/.local/lib/mate-node"; do
  [ ! -e "$path" ] && [ ! -L "$path" ] || { echo "Refusing existing Mate files: $path" >&2; exit 1; }
done
work=$(mktemp -d)
phase=bootstrap peer_pid= cli_pid=
cleanup() {
  result=$?
  if [ "$result" != 0 ]; then
    printf 'MATE_UNINSTALL_SMOKE_FAIL phase=%s exit=%s evidence=%s\n' "$phase" "$result" "$work" >&2
    for file in "$work"/*.log; do [ ! -f "$file" ] || { printf 'Evidence: %s\n' "$file" >&2; cat "$file" >&2; }; done
  fi
  if [ -n "$cli_pid" ]; then kill -KILL "$cli_pid" 2>/dev/null || true; wait "$cli_pid" 2>/dev/null || true; fi
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
printf 'MATE_UNINSTALL_SMOKE_PASS %s evidence=%s\n' "$version" "$work"
