#!/bin/sh
# Actual complete bundle/CLI/real user manager; synthetic compatible versions, no real provider.
set -eu
archive=$1
bootstrap=$2
checksum=$3
version=$4
cut_script=$5
test_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cut_timeout=${MATE_TEST_CUT_TIMEOUT_SECONDS:-180}
case "$cut_timeout" in ''|*[!0-9]*) echo 'Invalid test cut timeout' >&2; exit 1 ;; esac
[ "$cut_timeout" -ge 1 ] && [ "$cut_timeout" -le 1800 ] || { echo 'Test cut timeout must be 1..1800 seconds' >&2; exit 1; }
[ "$(id -u)" != 0 ] || { echo 'Use the existing ordinary test account' >&2; exit 1; }
[ "$(systemd-detect-virt --container 2>/dev/null || true)" = none ] || { echo 'Containers are not service acceptance' >&2; exit 1; }
command -v node >/dev/null 2>&1 && { echo 'Host Node must not supplement the bundle' >&2; exit 1; }
entry="$HOME/.local/bin/mate"
unit="$HOME/.config/systemd/user/mate-node.service"
config="$HOME/.config/mate/node.json"
data="$HOME/.local/share/mate/node"
program="$HOME/.local/lib/mate-node"
[ ! -e "$program" ] && [ ! -e "$entry" ] && [ ! -L "$entry" ] && [ ! -e "$unit" ] && [ ! -e "$config" ] && [ ! -e "$data" ] || { echo 'Refusing an account with existing Mate files' >&2; exit 1; }
work=$(mktemp -d)
phase=bootstrap
runtime=
update_pid=
observer_pid=
cleanup_cut() {
  if [ -f "$work/cut.json" ]; then
    "$runtime" "$test_directory/cleanup-update-cut.mjs" "$work/cut.json"
    rm "$work/cut.json"
  fi
  if [ -n "$update_pid" ]; then kill -KILL "$update_pid" 2>/dev/null || true; wait "$update_pid" 2>/dev/null || true; update_pid=; fi
  if [ -n "$observer_pid" ]; then kill "$observer_pid" 2>/dev/null || true; wait "$observer_pid" 2>/dev/null || true; observer_pid=; fi
}
cleanup() {
  result=$?
  if [ "$result" -ne 0 ]; then
    printf 'MATE_UPDATE_SMOKE_FAIL phase=%s exit=%s evidence=%s\n' "$phase" "$result" "$work" >&2
    for log in "$work"/*.log; do [ ! -f "$log" ] || { printf 'Evidence: %s\n' "$log" >&2; cat "$log" >&2; }; done
  fi
  cleanup_cut
  if [ -x "$entry" ]; then "$entry" node stop >"$work/cleanup-stop.log" 2>&1 || true; fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
printf 'Evidence OS=%s arch=%s uid=%s gid=%s virtualization=%s user-manager=%s linger=%s\n' \
  "$(. /etc/os-release; printf '%s:%s' "$ID" "$VERSION_ID")" "$(uname -m)" "$(id -u)" "$(id -g)" \
  "$(systemd-detect-virt)" "$(systemctl --user show --property=Version --value)" "$(loginctl show-user "$(id -u)" --property=Linger --value)"
printf 'Synthetic compatible releases from one actual build; no real control plane/provider/Release download\n'
sh "$bootstrap" --version "$version" --package "$archive" --sha256 "$checksum"
base="$program/versions/$version"
runtime="$base/node/bin/node"
mkdir -p "$HOME/.config/mate"
chmod 700 "$HOME/.config/mate"
printf '{"MATE_CONTROL_PLANE_URL":"http://127.0.0.1:18999","MATE_NODE_PAIRING_TOKEN":"mate-update-synthetic-unreachable-token-0000000"}\n' >"$config"
chmod 600 "$config"
phase=install-real-user-service
"$entry" node install >"$work/install.log" 2>&1
i=0
until [ -f "$data/node-identity.json" ]; do i=$((i+1)); [ "$i" -lt 60 ] || exit 1; sleep 1; done
phase=running-refusal
if "$entry" node update --version 0.2.0 --package "$archive" --sha256 "$checksum" >"$work/running.log" 2>&1; then exit 1; fi
grep -q 'must be stopped' "$work/running.log"
[ "$("$entry" --version)" = "$version" ]
"$entry" node stop
systemctl --user disable mate-node.service
mkdir -p "$data/agents/update-fixture"
printf 'owner workspace note\n' >"$data/agents/update-fixture/note.txt"
printf 'retained receipt evidence\n' >"$data/update-receipt.txt"
snapshot_data() { (cd "$data"; find . -type f -print0 | sort -z | xargs -0 sha256sum); sha256sum "$config"; }
snapshot_data >"$work/data.before"
cp "$unit" "$work/unit.before"
prepare_package() {
  selected=$1
  rm -rf "$work/package"
  mkdir "$work/package"
  tar -xzf "$archive" -C "$work/package" --no-same-owner --no-same-permissions
  "$runtime" --input-type=module -e '
    import { readFileSync, writeFileSync } from "node:fs";
    const file = process.argv[1],
      metadata = JSON.parse(readFileSync(file, "utf8"));
    metadata.version = process.argv[2];
    writeFileSync(file, JSON.stringify(metadata, null, 2) + "\n");
  ' "$work/package/mate-node/bundle.json" "$selected"
  tar -czf "$work/new.tar.gz" -C "$work/package" mate-node
  new_checksum=$(sha256sum "$work/new.tar.gz" | cut -d' ' -f1)
}
prepare_package 0.2.0
phase=checksum-failure-before-switch
if "$entry" node update --version 0.2.0 --package "$work/new.tar.gz" --sha256 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa >"$work/checksum.log" 2>&1; then exit 1; fi
grep -q SHA-256 "$work/checksum.log"
cmp "$unit" "$work/unit.before"
phase=new-cli-preflight-failure
cp "$work/new.tar.gz" "$work/good-v2.tar.gz"
good_checksum=$new_checksum
"$runtime" "$test_directory/damage-update-cli-fixture.mjs" "$work/package/mate-node"
tar -czf "$work/new.tar.gz" -C "$work/package" mate-node
new_checksum=$(sha256sum "$work/new.tar.gz" | cut -d' ' -f1)
if "$entry" node update --version 0.2.0 --package "$work/new.tar.gz" --sha256 "$new_checksum" >"$work/preflight.log" 2>&1; then exit 1; fi
grep -q 'preflight failed' "$work/preflight.log"
cmp "$unit" "$work/unit.before"
[ "$("$entry" --version)" = "$version" ]
snapshot_data >"$work/data.after"
cmp "$work/data.before" "$work/data.after"
phase=whole-bundle-self-update-via-public-download-entry
mkdir "$work/download-bin"
cat >"$work/download-bin/gh" <<'SH'
#!/bin/sh
set -eu
[ "${GH_TOKEN:-}" = mate-update-synthetic-download-token ] || exit 90
destination=
while [ "$#" -gt 0 ]; do if [ "$1" = --dir ]; then destination=$2; shift 2; else shift; fi; done
[ -n "$destination" ] || exit 91
cp "$MATE_TEST_DOWNLOAD_PACKAGE" "$destination/$MATE_TEST_DOWNLOAD_ASSET"
printf '%s  %s\n' "$MATE_TEST_DOWNLOAD_SHA" "$MATE_TEST_DOWNLOAD_ASSET" >"$destination/SHA256SUMS"
SH
chmod 700 "$work/download-bin/gh"
asset="mate-node-0.2.0-linux-$("$runtime" -p process.arch).tar.gz"
PATH="$work/download-bin:$PATH" GH_TOKEN=mate-update-synthetic-download-token MATE_TEST_DOWNLOAD_PACKAGE="$work/good-v2.tar.gz" MATE_TEST_DOWNLOAD_SHA="$good_checksum" MATE_TEST_DOWNLOAD_ASSET="$asset" "$entry" node update --version 0.2.0 >"$work/update-v2.log" 2>&1
grep -q 'updated to 0.2.0' "$work/update-v2.log"
! grep -q mate-update-synthetic-download-token "$work/update-v2.log"
[ "$("$entry" --version)" = 0.2.0 ]
[ "$("$base/bin/mate" --version)" = "$version" ]
"$entry" node status >"$work/v2-status.log"
grep -q 'Active: inactive' "$work/v2-status.log"
grep -q 'Enabled: disabled' "$work/v2-status.log"
snapshot_data >"$work/data.after"
cmp "$work/data.before" "$work/data.after"
begin_cut() {
  cut_phase=$1
  cut_version=$2
  runner=${3:-$entry}
  rm -f "$work/observer.ready" "$work/cut.json" "$work/update.pid"
  MATE_TEST_CUT_TIMEOUT_SECONDS="$cut_timeout" "$runtime" "$cut_script" "$entry" "$unit" "$cut_version" "$work/update.pid" "$work/observer.ready" "$work/cut.json" "$cut_phase" >"$work/observer.log" 2>&1 &
  observer_pid=$!
  i=0; until [ -f "$work/observer.ready" ]; do i=$((i+1)); [ "$i" -lt 100 ] || exit 1; sleep 0.1; done
  "$runner" node update --version "$cut_version" --package "$work/new.tar.gz" --sha256 "$new_checksum" >"$work/cut-update.log" 2>&1 &
  update_pid=$!
  printf '%s\n' "$update_pid" >"$work/update.pid"
  i=0; until [ -f "$work/cut.json" ]; do i=$((i+1)); [ "$i" -lt "$cut_timeout" ] || exit 1; sleep 1; done
  cat "$work/cut.json"
}
phase=entry-cut-and-concurrent-cli-management
systemctl --user enable mate-node.service
prepare_package 0.3.0
begin_cut entry 0.3.0
grep -q '^# Mate bundle version: 0.2.0$' "$unit"
for command in start install; do
  if "$entry" node "$command" >"$work/concurrent-$command.log" 2>&1; then exit 1; fi
  grep -q 'Another Mate management command' "$work/concurrent-$command.log"
done
if "$entry" node update --version 0.3.0 --package "$work/new.tar.gz" --sha256 "$new_checksum" >"$work/concurrent-update.log" 2>&1; then exit 1; fi
grep -q 'Another Mate management command' "$work/concurrent-update.log"
cleanup_cut
if "$entry" node status >"$work/partial-entry-status.log" 2>&1; then exit 1; fi
grep -q 'references differ' "$work/partial-entry-status.log"
if "$entry" node start >"$work/partial-entry-start.log" 2>&1; then exit 1; fi
grep -q references "$work/partial-entry-start.log"
"$entry" node update --version 0.3.0 --package "$work/new.tar.gz" --sha256 "$new_checksum" >"$work/recover-entry.log" 2>&1
"$entry" node status >"$work/v3-status.log"
grep -q 'Enabled: enabled' "$work/v3-status.log"
grep -q 'Active: inactive' "$work/v3-status.log"
phase=unit-moved-before-publish-cut
captured=no
for attempt in 1 2 3; do
  cut_version="0.3.1-unitmove-$attempt"
  prepare_package "$cut_version"
  begin_cut unit-moved "$cut_version"
  if [ ! -e "$unit" ]; then captured=yes; fi
  cleanup_cut
  if [ "$captured" = yes ]; then
    if "$entry" node status >"$work/missing-unit-status.log" 2>&1; then exit 1; fi
    grep -q 'references differ' "$work/missing-unit-status.log"
    if "$entry" node start >"$work/missing-unit-start.log" 2>&1; then exit 1; fi
    grep -q references "$work/missing-unit-start.log"
  else printf 'Unit move cut occurred after publish; retrying another synthetic release\n'; fi
  "$entry" node update --version "$cut_version" --package "$work/new.tar.gz" --sha256 "$new_checksum" >"$work/recover-moved-unit.log" 2>&1
  [ "$captured" = no ] || break
done
[ "$captured" = yes ] || { echo 'Missing canonical unit cut was not captured; this seam remains unverified' >&2; exit 1; }
"$entry" node status >"$work/recovered-moved-unit-status.log"
grep -q 'Enabled: enabled' "$work/recovered-moved-unit-status.log"
grep -q 'Active: inactive' "$work/recovered-moved-unit-status.log"
phase=unit-reload-cut
captured=no
for attempt in 1 2 3; do
  cut_version="0.4.0-unit-$attempt"
  prepare_package "$cut_version"
  begin_cut unit "$cut_version"
  if [ "$(systemctl --user show mate-node.service --property=NeedDaemonReload --value)" = yes ]; then captured=yes; fi
  cleanup_cut
  if [ "$captured" = yes ]; then
    if "$entry" node status >"$work/partial-unit-status.log" 2>&1; then exit 1; fi
    grep -q 'references differ' "$work/partial-unit-status.log"
    if "$entry" node start >"$work/partial-unit-start.log" 2>&1; then exit 1; fi
    grep -q references "$work/partial-unit-start.log"
  else printf 'Unit cut occurred after reload; retrying another synthetic release\n'; fi
  "$entry" node update --version "$cut_version" --package "$work/new.tar.gz" --sha256 "$new_checksum" >"$work/recover-unit.log" 2>&1
  [ "$captured" = no ] || break
done
[ "$captured" = yes ] || { echo 'Unit/reload cut was not captured; this seam remains unverified' >&2; exit 1; }
phase=broken-entry-local-cli-recovery
rm "$entry"
"$runtime" "$base/app/apps/node/dist/management/cli.js" node update --version "$cut_version" --package "$work/new.tar.gz" --sha256 "$new_checksum" >"$work/recover-public-entry.log" 2>&1
[ "$("$entry" --version)" = "$cut_version" ]
phase=same-version-damaged-program-recovery
current="$program/versions/$cut_version"
printf 'damaged public launcher\n' >"$current/bin/mate"
external="$work/package/mate-node"
phase=unknown-repair-file-conflict
printf 'foreign program note\n' >"$current/foreign-note"
if "$external/bin/mate" node update --version "$cut_version" --package "$work/new.tar.gz" --sha256 "$new_checksum" >"$work/unknown-repair-file.log" 2>&1; then exit 1; fi
grep -q 'Unknown file' "$work/unknown-repair-file.log"
grep -q 'foreign program note' "$current/foreign-note"
rm "$current/foreign-note"
phase=known-path-link-repair-conflict
printf 'foreign link target\n' >"$work/foreign-link-target"
rm "$current/bin/mate"
ln -s "$work/foreign-link-target" "$current/bin/mate"
if "$external/bin/mate" node update --version "$cut_version" --package "$work/new.tar.gz" --sha256 "$new_checksum" >"$work/known-path-link.log" 2>&1; then exit 1; fi
grep -q 'Unknown file' "$work/known-path-link.log"
[ -L "$current/bin/mate" ]
grep -q 'foreign link target' "$work/foreign-link-target"
rm "$current/bin/mate"
printf 'damaged public launcher\n' >"$current/bin/mate"
phase=repair-cleanup-interruption
begin_cut repair-cleanup "$cut_version" "$external/bin/mate"
# A pre-signal snapshot is not proof. Confirm the CLI is stopped and the actual backup is still partial.
"$runtime" "$test_directory/assert-repair-cleanup-cut.mjs" "$work/cut.json"
cleanup_cut
phase=same-version-damaged-program-recovery
"$external/node/bin/node" "$external/app/apps/node/dist/management/cli.js" node update --version "$cut_version" --package "$work/new.tar.gz" --sha256 "$new_checksum" >"$work/repair-same-version.log" 2>&1
[ "$("$entry" --version)" = "$cut_version" ]
"$entry" node status >"$work/final-status.log"
grep -q 'Active: inactive' "$work/final-status.log"
grep -q 'Enabled: enabled' "$work/final-status.log"
snapshot_data >"$work/data.after"
cmp "$work/data.before" "$work/data.after"
phase=explicit-final-start
"$entry" node start
"$entry" node status >"$work/started-status.log"
grep -q 'Active: active' "$work/started-status.log"
"$entry" node stop
printf 'MATE_UPDATE_SMOKE_PASS base=%s final=%s actual entry/unit/reload cuts; account=%s\n' "$version" "$cut_version" "$(id -u)"
