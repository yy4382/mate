#!/bin/sh
# Run only inside an explicitly authorized disposable Linux host/VM account.
# Real bootstrap/CLI/systemd/journal; WebSocket transport peer is a labelled fixture.
set -eu
archive=$1
bootstrap=$2
checksum=$3
version=$4
peer_script=$5
[ "$(id -u)" != 0 ] || {
  echo 'Run as the existing ordinary test account' >&2
  exit 1
}
[ "$(systemd-detect-virt --container 2>/dev/null || true)" = none ] || {
  echo 'Containers are not service acceptance' >&2
  exit 1
}
command -v node >/dev/null 2>&1 && {
  echo 'Host Node must not supplement the bundle' >&2
  exit 1
}
entry="$HOME/.local/bin/mate"
unit="$HOME/.config/systemd/user/mate-node.service"
config="$HOME/.config/mate/node.json"
data="$HOME/.local/share/mate/node"
[ ! -e "$entry" ] && [ ! -L "$entry" ] && [ ! -e "$unit" ] && [ ! -e "$config" ] && [ ! -e "$data" ] || {
  echo 'Refusing an account with existing Mate files' >&2
  exit 1
}
work=$(mktemp -d)
peer_pid=
phase=bootstrap
cleanup() {
  result=$?
  if [ "$result" -ne 0 ]; then
    printf 'MATE_USER_SERVICE_SMOKE_FAIL phase=%s exit=%s evidence=%s\n' "$phase" "$result" "$work" >&2
    for log in install peer journal new-journal status no-manager conflict command-conflict command-status config-error; do
      if [ -f "$work/$log.log" ]; then
        printf 'Evidence log: %s\n' "$log" >&2
        cat "$work/$log.log" >&2
      fi
    done
  fi
  if [ -f "$work/unit.saved" ]; then
    mv "$work/unit.saved" "$unit"
  fi
  if [ -f "$unit.d/00-mate-test.conf" ]; then
    rm "$unit.d/00-mate-test.conf"
    systemctl --user daemon-reload || true
  fi
  if [ -n "$peer_pid" ]; then
    kill "$peer_pid" 2>/dev/null || true
    wait "$peer_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
printf 'Evidence: OS=%s arch=%s uid=%s gid=%s virtualization=%s user-manager=%s linger=%s\n' \
  "$(. /etc/os-release; printf '%s:%s' "$ID" "$VERSION_ID")" "$(uname -m)" "$(id -u)" "$(id -g)" \
  "$(systemd-detect-virt)" "$(systemctl --user show --property=Version --value)" "$(loginctl show-user "$(id -u)" --property=Linger --value)"
printf 'Peer: external synthetic WebSocket protocol fixture; no real control plane/provider\n'
sh "$bootstrap" --version "$version" --package "$archive" --sha256 "$checksum"
[ "$("$entry" --version)" = "$version" ]
bundle="$HOME/.local/lib/mate-node/versions/$version"
runtime="$bundle/node/bin/node"
phase=protocol-peer
"$runtime" "$peer_script" "$bundle" "$work" >"$work/peer.log" 2>&1 &
peer_pid=$!
i=0
until grep -q MATE_TEST_PEER_READY "$work/peer.log"; do
  i=$((i + 1))
  [ "$i" -lt 100 ] || {
    cat "$work/peer.log"
    exit 1
  }
  sleep 0.1
done
mkdir -p "$HOME/.config/mate"
chmod 700 "$HOME/.config/mate"
write_config() {
  printf '{"MATE_CONTROL_PLANE_URL":"http://127.0.0.1:18789","MATE_NODE_PAIRING_TOKEN":"%s"}\n' "$1" >"$config"
  chmod 600 "$config"
}
phase=first-install-rejected-token
write_config mate-service-synthetic-rejected-token-0000000
"$entry" node install >"$work/install.log" 2>&1
wait_log() {
  wanted=$1
  i=0
  while :; do
    "$entry" node logs --lines 200 >"$work/journal.log" 2>&1
    if [ -n "${journal_cursor:-}" ]; then
      # The cursor supplies freshness; CLI above independently verifies the public log command.
      journalctl --user --unit mate-node.service --after-cursor "$journal_cursor" --no-pager >"$work/new-journal.log"
      grep -q "$wanted" "$work/new-journal.log" && break
    else
      grep -q "$wanted" "$work/journal.log" && break
    fi
    i=$((i + 1))
    [ "$i" -lt 60 ] || {
      cat "$work/journal.log"
      exit 1
    }
    sleep 1
  done
}
wait_log '配对令牌无效'
identity_before=$(sha256sum "$data/node-identity.json" | cut -d' ' -f1)
phase=retry-original-identity
write_config mate-service-synthetic-valid-token-0000000000
"$entry" node restart
wait_log MATE_NODE_PAIRED
[ "$(sha256sum "$data/node-identity.json" | cut -d' ' -f1)" = "$identity_before" ]
"$entry" node status >"$work/status.log"
grep -q 'Active: active' "$work/status.log"
! grep -q 'mate-service-synthetic' "$work/status.log"
! grep -q 'mate-service-synthetic' "$unit"
! grep -q 'mate-service-synthetic' "$work/journal.log"
phase=repeat-install
pid_before=$(systemctl --user show mate-node.service --property=MainPID --value)
"$entry" node install
[ "$(systemctl --user show mate-node.service --property=MainPID --value)" = "$pid_before" ]
phase=stopped-disabled-preservation
"$entry" node stop
# Raw systemctl below prepares the user's disabled choice, not a substitute management path.
systemctl --user disable mate-node.service
"$entry" node install
sleep 6
[ "$(systemctl --user show mate-node.service --property=ActiveState --value)" = inactive ]
[ "$(systemctl --user show mate-node.service --property=UnitFileState --value)" = disabled ]
phase=custom-service-environment
mkdir -p "$unit.d"
printf 'MATE_NODE_CONFIG_FILE=/non-mate-config\nPATH=/usr/bin:/bin\n' >"$work/service-environment"
printf '[Service]\nEnvironmentFile=%s\n' "$work/service-environment" >"$unit.d/00-mate-test.conf"
"$entry" node install
phase=identity-first
journal_cursor=$(journalctl --user --unit mate-node.service --lines 1 --show-cursor --no-pager | sed -n 's/^-- cursor: //p')
[ -n "$journal_cursor" ] || {
  echo 'Journal cursor unavailable' >&2
  exit 1
}
# A paired identity authenticates first even with a stale/rejected token still in the file.
write_config mate-service-synthetic-rejected-token-0000000
"$entry" node start
wait_log MATE_NODE_CONNECTED
[ "$(sha256sum "$data/node-identity.json" | cut -d' ' -f1)" = "$identity_before" ]
pid_before=$(systemctl --user show mate-node.service --property=MainPID --value)
phase=crash-recovery
[ "$pid_before" -gt 0 ] || {
  echo 'No running node PID to crash' >&2
  exit 1
}
kill -KILL "$pid_before"
i=0
while :; do
  pid_after=$(systemctl --user show mate-node.service --property=MainPID --value)
  [ "$pid_after" != 0 ] && [ "$pid_after" != "$pid_before" ] && break
  i=$((i + 1))
  [ "$i" -lt 60 ] || exit 1
  sleep 1
done
"$entry" node stop
sleep 6
[ "$(systemctl --user show mate-node.service --property=ActiveState --value)" = inactive ]
phase=effective-command-conflict
printf '[Service]\nExecStart=\nExecStart=/usr/bin/false\n' >"$unit.d/00-mate-test.conf"
systemctl --user daemon-reload
if "$entry" node start >"$work/command-conflict.log" 2>&1; then
  exit 1
fi
grep -q references "$work/command-conflict.log"
if "$entry" node status >"$work/command-status.log" 2>&1; then
  exit 1
fi
grep -q 'references differ' "$work/command-status.log"
"$entry" node stop
phase=multiline-command-conflict
printf '%s\n' '[Service]' 'ExecStart=' 'ExecStart=/usr/bin/false "node\"\n string \"--config-file\"\n string \"config"' >"$unit.d/00-mate-test.conf"
systemctl --user daemon-reload
if "$entry" node start >"$work/multiline-command.log" 2>&1; then
  exit 1
fi
grep -q references "$work/multiline-command.log"
"$entry" node stop
"$entry" node logs --lines 10 >"$work/multiline-journal.log" 2>&1
rm "$unit.d/00-mate-test.conf"
rmdir "$unit.d"
"$entry" node install
phase=missing-user-manager
mkdir -p "$work/no-manager"
if XDG_RUNTIME_DIR="$work/no-manager" DBUS_SESSION_BUS_ADDRESS="unix:path=$work/no-manager/no-bus" "$entry" node install >"$work/no-manager.log" 2>&1; then
  exit 1
fi
grep -q 'User manager unavailable' "$work/no-manager.log"
phase=foreign-unit-conflict
cp "$unit" "$work/unit.saved"
printf '[Service]\nExecStart=/non-mate-fixture\n' >"$unit"
if "$entry" node install >"$work/conflict.log" 2>&1; then
  exit 1
fi
grep -q 'Non-Mate' "$work/conflict.log"
grep -q /non-mate-fixture "$unit"
mv "$work/unit.saved" "$unit"
"$entry" node install
[ "$(systemctl --user show mate-node.service --property=ActiveState --value)" = inactive ]
phase=private-configuration
chmod 644 "$config"
if "$entry" node status >"$work/config-error.log" 2>&1; then
  exit 1
fi
grep -q private "$work/config-error.log"
chmod 600 "$config"
[ "$(sha256sum "$data/node-identity.json" | cut -d' ' -f1)" = "$identity_before" ]
"$entry" node status
printf 'MATE_USER_SERVICE_SMOKE_PASS %s\n' "$version"
