#!/bin/sh
# Native systemd contract test. Run as root on the target Linux host with a
# temporary directory containing this repo's compiled readiness.js renamed to
# readiness.mjs and the adjacent native-readiness.mjs fixture. The directory
# and transient units are removed on exit.
set -eu

test "$(id -u)" -eq 0
directory=${1:?Provide the temporary fixture directory}
test -f "$directory/readiness.mjs"
test -f "$directory/native-readiness.mjs"
unit="mate-readiness-test-$$.service"
failed_unit="mate-readiness-failure-$$.service"
cleanup() {
  systemctl stop "$unit" "$failed_unit" >/dev/null 2>&1 || true
  systemctl reset-failed "$unit" "$failed_unit" >/dev/null 2>&1 || true
  rm -rf -- "$directory"
}
trap cleanup EXIT HUP INT TERM

state() { systemctl show --value --property=ActiveState "$1"; }
await_state() {
  expected=$2
  attempt=0
  while [ "$attempt" -lt 100 ]; do
    actual=$(state "$1")
    [ "$actual" = "$expected" ] && return 0
    attempt=$((attempt + 1))
    sleep 0.1
  done
  echo "Expected $1 to be $expected, found $actual" >&2
  return 1
}

systemd-run --quiet --no-block --unit="$unit" \
  --property=Type=notify --property=NotifyAccess=all \
  --property=Restart=no --property=TimeoutStartSec=2s \
  /usr/bin/node "$directory/native-readiness.mjs" "$directory/ready" success
await_state "$unit" activating
sleep 3
test "$(state "$unit")" = activating
touch "$directory/ready"
await_state "$unit" active

rm "$directory/ready"
systemctl restart --no-block "$unit" >/dev/null
await_state "$unit" activating
sleep 3
test "$(state "$unit")" = activating
touch "$directory/ready"
await_state "$unit" active

systemd-run --quiet --no-block --unit="$failed_unit" \
  --property=Type=notify --property=NotifyAccess=all \
  --property=Restart=no --property=TimeoutStartSec=15s \
  /usr/bin/node "$directory/native-readiness.mjs" "$directory/fail" fail
touch "$directory/fail"
await_state "$failed_unit" failed
printf 'Native systemd readiness: activating, active, restart, and failure states passed.\n'
