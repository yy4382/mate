#!/bin/sh
set -eu

release=${1:?release directory required}
root=${2:-/var/tmp/mate-v2b-native-$$}
uid=$(id -u mate)
gid=$(id -g mate)

name=$(basename "$root")
test "$(dirname "$root")" = /var/tmp || { printf '%s\n' 'validation root parent must be /var/tmp' >&2; exit 2; }
case "$name" in mate-v2b-native-?*) ;; *) printf '%s\n' 'validation root must use the mate-v2b-native-* prefix' >&2; exit 2;; esac
case "$name" in *[!A-Za-z0-9._-]*) printf '%s\n' 'validation root contains unsafe characters' >&2; exit 2;; esac
test ! -e "$root" || { printf '%s\n' 'validation root already exists' >&2; exit 2; }
mkdir -m 700 "$root"
printf '%s\n' 'mate-v2b-native-validation' > "$root/.identity"
chmod 600 "$root/.identity"
chown root:"$gid" "$root"
chmod 750 "$root"

cleanup() {
  set +e
  test -f "$root/.identity" || return
  test ! -L "$root" || return
  test "$(cat "$root/.identity" 2>/dev/null)" = 'mate-v2b-native-validation' || return
  umount "$root/external" 2>/dev/null
  umount "$root/data/agents/writer" 2>/dev/null
  umount "$root/data/agents/research" 2>/dev/null
  for backing in "$root"/volumes/*.ext4; do
    losetup -j "$backing" 2>/dev/null | cut -d: -f1 | while read -r loop; do test -z "$loop" || losetup -d "$loop"; done
  done
  rm -rf "$root"
}
trap cleanup EXIT INT TERM

mkdir -p "$root/data/state" "$root/data/control" "$root/data/agents/research" "$root/data/agents/writer" "$root/external" "$root/volumes" "$root/backups"
for name in research writer external; do
  backing="$root/volumes/$name.ext4"
  truncate -s 64M "$backing"
  mkfs.ext4 -q "$backing"
  fallocate -l 64M "$backing"
  chmod 600 "$backing"
  case "$name" in
    external) mountpoint="$root/external" ;;
    *) mountpoint="$root/data/agents/$name" ;;
  esac
  mount -o loop,nodev,nosuid "$backing" "$mountpoint"
  chown "$uid:$gid" "$mountpoint"
done
chown -R "$uid:$gid" "$root/data"
chown root:"$gid" "$root/backups"
chmod 700 "$root/data" "$root/data/state" "$root/data/control" "$root/data/agents" "$root/data/agents/research" "$root/data/agents/writer"
chmod 700 "$root/external"
chmod 750 "$root/backups"
touch "$root/data/state/daemon.lock"
chown "$uid:$gid" "$root/data/state/daemon.lock"
chmod 600 "$root/data/state/daemon.lock"
printf '%s' 'external-untouched' > "$root/external/sentinel"
chown "$uid:$gid" "$root/external/sentinel"

cat > "$root/config.json" <<EOF
{
  "version": 2,
  "mate": {
    "agents": [
      {"id":"research","name":"Research","role":"Research evidence","model":{"provider":"synthetic","id":"synthetic","apiKeyEnv":"MODEL_API_KEY"}},
      {"id":"writer","name":"Writer","role":"Write evidence","model":{"provider":"synthetic","id":"synthetic","apiKeyEnv":"MODEL_API_KEY"}}
    ],
    "ownerUserIds": ["owner"],
    "budgets": {"maxRuns":10,"maxTokens":100000,"maxCostUsd":10,"runTimeoutMs":300000}
  },
  "adapters": {"local":{"humans":["owner"],"rooms":[{"id":"room","agents":["research","writer"],"humans":["owner"]}]}},
  "runtime": {
    "dataDir": "$root/data",
    "workspaceManifest": "$root/workspaces.json",
    "workspaceGrants": [{"agentId":"research","root":"$root/external","operations":["read"]}],
    "researchHosts": []
  }
}
EOF
cat > "$root/workspaces.json" <<EOF
{
  "version": 1,
  "mounts": [
    {"kind":"private","agentId":"research","root":"$root/data/agents/research","backingFile":"$root/volumes/research.ext4","capacityBytes":67108864,"ownerUid":$uid,"ownerGid":$gid},
    {"kind":"private","agentId":"writer","root":"$root/data/agents/writer","backingFile":"$root/volumes/writer.ext4","capacityBytes":67108864,"ownerUid":$uid,"ownerGid":$gid},
    {"kind":"external","root":"$root/external","backingFile":"$root/volumes/external.ext4","capacityBytes":67108864,"ownerUid":$uid,"ownerGid":$gid}
  ]
}
EOF
chown root:"$gid" "$root/config.json" "$root/workspaces.json"
chmod 640 "$root/config.json" "$root/workspaces.json"

for name in target current post; do mkdir "$root/backups/$name"; chown "$uid:$gid" "$root/backups/$name"; chmod 700 "$root/backups/$name"; done
run_mate() { runuser -u mate -- node "$release/scripts/validate-v2b-native.mjs" "$1" "$root"; }
seal() { node "$release/dist/src/main.js" checkpoint-seal "$root/config.json" "$root/backups/$1" "$uid" "$gid"; }

run_mate target
seal target
run_mate current
seal current

available=$(df --output=avail -B1 "$root/data/agents/research" | tail -1 | tr -d ' ')
fill=$((available - 4 * 1024 * 1024))
test "$fill" -gt 0
fallocate -l "$fill" "$root/data/agents/research/lost+found/native-fill"
run_mate capacity
test ! -e "$root/data/control/restore.json"
rm "$root/data/agents/research/lost+found/native-fill"

set +e
run_mate kill-agent
status=$?
set -e
test "$status" -eq 137
run_mate assert-mid
run_mate resume-target

run_mate post
seal post
run_mate decide-current
test -e "$root/data/control/restore.json"
original=$(cat "$root/backups/current/agents/research/MEMORY.md")
printf '%s' corrupt > "$root/backups/current/agents/research/MEMORY.md"
set +e
tamper_output=$(run_mate resume-current 2>&1)
status=$?
set -e
test "$status" -ne 0
printf '%s' "$tamper_output" | grep -Eq 'inventory|changed'
printf '%s' "$original" > "$root/backups/current/agents/research/MEMORY.md"
chown root:"$gid" "$root/backups/current/agents/research/MEMORY.md"
chmod 640 "$root/backups/current/agents/research/MEMORY.md"
run_mate resume-current
run_mate assert-final

test "$(stat -c '%u:%g %a' "$root/backups/current")" = "0:$gid 750"
test "$(stat -c '%u:%g %a' "$root/backups/current/COMPLETE.json")" = "0:$gid 640"
printf '%s\n' 'V2b native validation passed: sealed ownership, real ext4 capacity refusal, SIGKILL resume, DB-last ordering, source tamper repair, external exclusion.'
