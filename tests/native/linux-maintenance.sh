#!/bin/sh
# Native Linux maintenance validation. Run as root on a RESETTABLE Debian 13 x86_64 host.
#
# It uses two ordinary unprivileged Agent accounts, then drives the installed maintenance commands
# through one full path: preflight, install, doctor, start, systemd process control, recorded Agent
# work, backup, program upgrade, configuration change, restart, restore, and the refusal of a
# checkpoint that no longer matches its manifest. It ends by writing one JSON document that records
# what ran here and marks the checks a non-Linux host cannot execute.
#
# A failing step stops the run and exits non-zero. No step is skipped silently and no synthetic
# repository test is presented as a native result. Real Slack, model-provider and VPS connections
# are never made, and this script does not claim them.
#
# Usage:
#   tests/native/linux-maintenance.sh CONFIG DEPLOY_SPEC RELEASE_DIR [NEXT_SPEC] [AGENT] [AGENT]
#
#   CONFIG        the deployment configuration the installer copies to /etc/mate/mate.json
#   DEPLOY_SPEC   the deployment spec JSON (release.source: RELEASE_DIR, configSource: CONFIG)
#   RELEASE_DIR   a built release tree (dist/, node_modules/, package.json, pnpm-lock.yaml)
#   NEXT_SPEC     an optional second deployment spec whose release.source is a different built
#                 release; when given, the upgrade step installs it and the run proves that a new
#                 program version keeps the same data. Without it the upgrade step asserts the
#                 documented "candidate is already the current release" refusal instead.
#   AGENT         Agent ids to validate; defaults to the first two Agents in CONFIG
set -eu

PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
CONFIG=${1:?Usage: linux-maintenance.sh CONFIG DEPLOY_SPEC RELEASE_DIR [NEXT_SPEC] [AGENT] [AGENT]}
SPEC=${2:?Provide the deployment spec JSON}
RELEASE=${3:?Provide the built release directory}
NEXT_SPEC=${4-}
AGENT_ONE=${5-}
AGENT_TWO=${6-}
HERE=$(cd "$(dirname "$0")" && pwd)
HARNESS="$HERE/linux-maintenance.mjs"
NODE=${MATE_NODE:-/usr/bin/node}
SLEEP=$(command -v sleep || echo /bin/sleep)

log() { printf '%s\n' "$*" >&2; }
die() { printf 'FAILED: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "This validation must run as root"
[ -f "$CONFIG" ] || die "No configuration at $CONFIG"
[ -f "$SPEC" ] || die "No deployment spec at $SPEC"
[ -d "$RELEASE/dist/src" ] || die "No built release at $RELEASE"
[ -f "$HARNESS" ] || die "Missing $HARNESS"
command -v setpriv >/dev/null 2>&1 || die "setpriv is required"
[ -x "$NODE" ] || die "No Node at $NODE"
# Every permission probe runs through setpriv, so a broken setpriv would make "denied" meaningless.
setpriv --reuid=0 --regid=0 --clear-groups /bin/true >/dev/null 2>&1 ||
  die "setpriv cannot switch identity on this host; permission probes would be meaningless"
UUID_SOURCE=/proc/sys/kernel/random/uuid
[ -r "$UUID_SOURCE" ] || die "The daemon names Agent scopes with a UUID; $UUID_SOURCE is required"

# Read one expression out of the deployment configuration as JSON. The expression is evaluated in
# Node, where the configuration's own values are strings, so no configuration text reaches the shell.
read_config() {
  "$NODE" -e '
    const fs=require("fs"),c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const value=Function("c","return ("+process.argv[2]+")")(c);
    process.stdout.write(typeof value==="string"?value:JSON.stringify(value));' \
    "$CONFIG" "$1"
}
# Read one Agent's account facts as JSON: {"username","uid","gid","home"}.
read_account() {
  "$NODE" -e '
    const fs=require("fs"),c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const u=(c.runtime.linuxUsers??{})[process.argv[2]];
    if(!u) throw new Error(`No Linux identity for ${process.argv[2]}`);
    process.stdout.write(JSON.stringify(u));' "$CONFIG" "$1"
}
# Pull one string field out of a JSON object on stdin, or the empty string when it is absent.
field() { "$NODE" -e '
    const fs=require("fs");const v=JSON.parse(fs.readFileSync(0,"utf8"))[process.argv[1]];
    process.stdout.write(v===undefined||v===null?"":String(v))' "$1"; }

DATA=/var/lib/mate
BACKUPS=/var/backups/mate
SHARED=$(read_config 'c.runtime.sharedRoot ?? ""')
[ -n "$SHARED" ] || die "The configuration needs a shared root for Agent workspaces"
CURRENT_CHECKPOINT="$BACKUPS/current-state"
TARGET_CHECKPOINT="$BACKUPS/target-state"
WORK=$(mktemp -d /var/tmp/mate-native-XXXXXX)
MARKERS="$WORK/markers"
PHASES="$WORK/phases"
mkdir -p "$MARKERS" "$PHASES"

# Record one phase as JSON. Every phase names what was verified and how it ran.
phase() { # phase NAME STATUS DETAIL
  "$NODE" -e 'require("fs").writeFileSync(process.argv[1],JSON.stringify({name:process.argv[2],status:process.argv[3],detail:process.argv[4]})+"\n")' \
    "$PHASES/$1.json" "$1" "$2" "$3"
  log "  [$2] $1: $3"
}
fail() { phase "$1" failed "$2"; exit 1; }

if [ -z "${AGENT_ONE-}" ] || [ -z "${AGENT_TWO-}" ]; then
  AGENTS=$(read_config 'c.mate.agents.map(a=>a.id).join(" ")')
  # shellcheck disable=SC2086 # the configuration lists the ids this validation runs over
  set -- $AGENTS
  AGENT_ONE=${AGENT_ONE:-$1}
  AGENT_TWO=${AGENT_TWO:-$2}
fi
[ -n "$AGENT_ONE" ] && [ -n "$AGENT_TWO" ] || die "Two Agent ids are required"
ONE_ACCOUNT=$(read_account "$AGENT_ONE")
TWO_ACCOUNT=$(read_account "$AGENT_TWO")
USER_ONE=$(printf '%s' "$ONE_ACCOUNT" | field username)
UID_ONE=$(printf '%s' "$ONE_ACCOUNT" | field uid)
GID_ONE=$(printf '%s' "$ONE_ACCOUNT" | field gid)
HOME_ONE=$(printf '%s' "$ONE_ACCOUNT" | field home)
USER_TWO=$(printf '%s' "$TWO_ACCOUNT" | field username)
UID_TWO=$(printf '%s' "$TWO_ACCOUNT" | field uid)
GID_TWO=$(printf '%s' "$TWO_ACCOUNT" | field gid)
HOME_TWO=$(printf '%s' "$TWO_ACCOUNT" | field home)
[ -n "$USER_ONE" ] && [ -n "$USER_TWO" ] || die "Both Agent identities need a username"
[ -n "$HOME_ONE" ] && [ -n "$HOME_TWO" ] || die "Both Agent identities need a home directory"
[ "$UID_ONE" != "$UID_TWO" ] || die "The two Agents must have distinct UIDs"

# Verify one marker against the live database, and optionally against a published checkpoint.
# `verify_marker MARKER [CHECKPOINT [WORKSPACE [EXPECT_CONFIG [CONFIG]]]]`
verify_marker() {
  marker=$1; checkpoint=${2-}; workspace=${3-}; expectation=${4-unchanged}; config=${5-}
  if [ -n "$config" ]; then
    if [ -n "$checkpoint" ]; then
      "$NODE" "$HARNESS" verify --release "$RELEASE" --store "$DATA/state/mate.sqlite" \
        --marker "$marker" --checkpoint "$checkpoint" --workspace "$workspace" \
        --expectConfig "$expectation" --config "$config"
    else
      "$NODE" "$HARNESS" verify --release "$RELEASE" --store "$DATA/state/mate.sqlite" \
        --marker "$marker" --expectConfig "$expectation" --config "$config"
    fi
  elif [ -n "$checkpoint" ]; then
    "$NODE" "$HARNESS" verify --release "$RELEASE" --store "$DATA/state/mate.sqlite" \
      --marker "$marker" --checkpoint "$checkpoint" --workspace "$workspace" \
      --expectConfig "$expectation"
  else
    "$NODE" "$HARNESS" verify --release "$RELEASE" --store "$DATA/state/mate.sqlite" \
      --marker "$marker" --expectConfig "$expectation"
  fi
}
# Wait for a genuinely running service, not for a crash-looping unit that is briefly "active".
await_service() { # await_service PHASE
  attempt=0
  while [ "$attempt" -lt 120 ]; do
    state=$(systemctl show --value --property=ActiveState mate.service)
    sub=$(systemctl show --value --property=SubState mate.service)
    [ "$state" = active ] && [ "$sub" = running ] && return 0
    attempt=$((attempt + 1))
    "$SLEEP" 0.5
  done
  fail "$1" "mate.service did not reach active/running: $(systemctl status mate.service --no-pager -l | tail -5)"
}
# The host and run facts a `native` report has to attest; a run without them is a fixture. The
# release links and the phase digest bind the document to what actually ran, so a report cannot be
# relabelled or reused for a different run. The digest comes from the harness itself, which also
# recomputes it when it builds the report.
write_attestation() {
  digest=$("$NODE" "$HARNESS" digest --phases "$PHASES") ||
    die "Could not digest the phase reports"
  MATE_PHASE_DIGEST=$digest
  export MATE_PHASE_DIGEST
  "$NODE" -e '
    const fs=require("fs");
    fs.writeFileSync(process.argv[1],JSON.stringify({
      platform: process.platform,
      euid: process.geteuid ? process.geteuid() : -1,
      systemd: fs.existsSync("/run/systemd/system"),
      maintenanceCommands: fs.existsSync("/usr/local/sbin/matectl"),
      uname: require("node:os").release(),
      node: process.version,
      releaseBefore: process.env.MATE_RELEASE_BEFORE ?? null,
      releaseAfter: process.env.MATE_RELEASE_AFTER ?? null,
      phaseDigest: process.env.MATE_PHASE_DIGEST,
    },null,2)+"\n",{mode:0o600})' "$WORK/attestation.json"
}

log "Native maintenance validation on $(uname -srm)"
log "Agents: $AGENT_ONE ($USER_ONE/$UID_ONE), $AGENT_TWO ($USER_TWO/$UID_TWO); data $DATA; shared $SHARED"

# ---------------------------------------------------------------- install and checks
log "== preflight, install and doctor =="
"$NODE" "$RELEASE/dist/src/deployment/cli.js" preflight "$SPEC" >"$WORK/preflight.json" ||
  fail install-and-checks "preflight failed: $(cat "$WORK/preflight.json")"
"$NODE" "$RELEASE/dist/src/deployment/cli.js" install "$SPEC" >"$WORK/install.json" ||
  fail install-and-checks "install failed"
"$NODE" "$RELEASE/dist/src/main.js" doctor /etc/mate/mate.json --allow-missing-secrets \
  >"$WORK/doctor.json" ||
  fail install-and-checks "doctor failed: $(cat "$WORK/doctor.json")"
phase install-and-checks passed "preflight, install and doctor ran through the installed release"

# ---------------------------------------------------------------- real UID, GID and directory modes
log "== real Agent UID, private and shared directory permissions =="
expect_owner() { # expect_owner LABEL PATH UID GID MODE
  actual=$(stat -c '%u %g %a' "$2" 2>/dev/null) ||
    fail permissions "$1 does not exist or cannot be inspected: $2"
  [ "$actual" = "$3 $4 $5" ] || fail permissions "$1 is $actual, expected $3 $4 $5"
  phase "$1" passed "$1 is $actual"
}
expect_owner agent-private-home-one "$HOME_ONE" "$UID_ONE" "$GID_ONE" 700
expect_owner agent-private-home-two "$HOME_TWO" "$UID_TWO" "$GID_TWO" 700
expect_owner agent-shared-directory-one "$SHARED/$AGENT_ONE" "$UID_ONE" "$GID_ONE" 755
expect_owner agent-shared-directory-two "$SHARED/$AGENT_TWO" "$UID_TWO" "$GID_TWO" 755
expect_owner mate-data-directory "$DATA" 0 0 700
expect_owner mate-state-directory "$DATA/state" 0 0 700
expect_owner mate-environment-file /etc/mate/mate.env 0 0 600
expect_owner mate-configuration-file /etc/mate/mate.json 0 0 600

# The kernel, not this script, decides these outcomes: every probe runs under an Agent's account.
denied() { # denied UID GID LABEL COMMAND...
  uid=$1; gid=$2; label=$3; shift 3
  if setpriv --reuid="$uid" --regid="$gid" --clear-groups "$@" >/dev/null 2>&1; then
    fail "$label" "$label unexpectedly succeeded"
  fi
  phase "$label" passed "$label is denied by the kernel"
}
allowed() { # allowed UID GID LABEL COMMAND...
  uid=$1; gid=$2; label=$3; shift 3
  setpriv --reuid="$uid" --regid="$gid" --clear-groups "$@" >/dev/null 2>&1 ||
    fail "$label" "$label unexpectedly failed"
  phase "$label" passed "$label is allowed by the kernel"
}
printf 'agent-one private note\n' >"$HOME_ONE/notes/validation.txt"
printf 'agent-two private note\n' >"$HOME_TWO/notes/validation.txt"
printf 'agent-one shared note\n' >"$SHARED/$AGENT_ONE/validation.txt"
printf 'agent-two shared note\n' >"$SHARED/$AGENT_TWO/validation.txt"
chown "$UID_ONE:$GID_ONE" "$HOME_ONE/notes/validation.txt" "$SHARED/$AGENT_ONE/validation.txt"
chown "$UID_TWO:$GID_TWO" "$HOME_TWO/notes/validation.txt" "$SHARED/$AGENT_TWO/validation.txt"
chmod 600 "$HOME_ONE/notes/validation.txt" "$HOME_TWO/notes/validation.txt"
allowed "$UID_ONE" "$GID_ONE" agent-reads-own-memory /bin/cat "$HOME_ONE/MEMORY.md"
denied "$UID_ONE" "$GID_ONE" agent-cannot-read-peer-memory /bin/cat "$HOME_TWO/MEMORY.md"
denied "$UID_ONE" "$GID_ONE" agent-cannot-list-peer-home /bin/ls "$HOME_TWO"
allowed "$UID_ONE" "$GID_ONE" agent-writes-own-shared /usr/bin/touch "$SHARED/$AGENT_ONE/validation-write"
denied "$UID_ONE" "$GID_ONE" agent-cannot-write-peer-shared /usr/bin/touch "$SHARED/$AGENT_TWO/validation-write"
denied "$UID_ONE" "$GID_ONE" agent-cannot-read-mate-database /bin/cat "$DATA/state/mate.sqlite"
denied "$UID_ONE" "$GID_ONE" agent-cannot-read-mate-environment /bin/cat /etc/mate/mate.env
denied "$UID_ONE" "$GID_ONE" agent-cannot-read-mate-service /bin/cat /etc/systemd/system/mate.service
denied "$UID_ONE" "$GID_ONE" agent-cannot-control-mate-service /usr/bin/systemctl stop mate.service

# ---------------------------------------------------------------- the application starts
log "== start mate.service and reach readiness without Slack =="
systemctl enable --now mate.service >/dev/null
await_service service-start
phase service-start passed "mate.service reported active/running; Slack readiness is reported separately"

# ---------------------------------------------------------------- real process control
log "== systemd slice and scope process control =="
# The daemon only recognises scopes named <slice-prefix>-<uuid>.scope (LinuxProcessManager.unitPattern),
# so this check uses exactly that name and then asks the project's own listing code to find it.
AGENT_SLICE="mate-agent-$UID_ONE.slice"
SCOPE_UNIT="mate-agent-$UID_ONE-$(tr -d '\n' <"$UUID_SOURCE").scope"
systemctl reset-failed "$SCOPE_UNIT" >/dev/null 2>&1 || true
# `systemd-run --scope` stays in the foreground for the command's whole lifetime, so start it in the
# background and wait for the unit itself instead of for the command to finish.
systemd-run --quiet --scope --unit="$SCOPE_UNIT" --slice="$AGENT_SLICE" \
  --property=MemoryMax=268435456 --property=TasksMax=128 \
  setpriv --reuid="$UID_ONE" --regid="$GID_ONE" --clear-groups "$SLEEP" 120 >/dev/null 2>&1 &
scope_wait=0
main_pid=0
while [ "$scope_wait" -lt 40 ]; do
  main_pid=$(systemctl show --value --property=MainPID "$SCOPE_UNIT" 2>/dev/null || echo 0)
  [ -n "$main_pid" ] && [ "$main_pid" != 0 ] && break
  scope_wait=$((scope_wait + 1))
  "$SLEEP" 0.25
done
[ -n "$main_pid" ] && [ "$main_pid" != 0 ] ||
  fail process-control "could not create an Agent scope in $AGENT_SLICE"
[ "$(stat -c '%u' "/proc/$main_pid")" = "$UID_ONE" ] ||
  fail process-control "the scope process belongs to UID $(stat -c '%u' "/proc/$main_pid"), not $UID_ONE"
[ "$(systemctl show --value --property=Slice "$SCOPE_UNIT")" = "$AGENT_SLICE" ] ||
  fail process-control "the scope did not run inside $AGENT_SLICE"
# The project's own listing query must return it, or an Agent could not see its own processes.
"$NODE" -e '
  const { LinuxProcessManager } = require(process.argv[1]);
  const { execFileSync } = require("node:child_process");
  const manager = new LinuxProcessManager(
    { [process.argv[2]]: Number(process.argv[3]) },
    (args) => {
      try {
        return {
          code: 0,
          stdout: execFileSync("/usr/bin/systemctl", args, { encoding: "utf8" }),
          stderr: "",
        };
      } catch (error) {
        return { code: error.status ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
      }
    },
  );
  manager
    .list(process.argv[2])
    .then((scopes) => {
      if (!scopes.some((scope) => scope.unit === process.argv[4]))
        throw new Error("the listing did not return " + process.argv[4]);
      process.stdout.write("listed\n");
    })
    .catch((error) => {
      process.stderr.write(error.message + "\n");
      process.exit(1);
    });' \
  "$RELEASE/dist/src/execution/linux-processes.js" "$AGENT_ONE" "$UID_ONE" "$SCOPE_UNIT" >/dev/null ||
  fail process-control "the project's own process listing did not return $SCOPE_UNIT"
systemctl stop "$SCOPE_UNIT"
systemctl reset-failed "$SCOPE_UNIT" >/dev/null 2>&1 || true
[ ! -d "/proc/$main_pid" ] || fail process-control "process $main_pid survived the stop"
phase process-control passed "an Agent-owned process ran as UID $UID_ONE in $AGENT_SLICE, was listed by the project's own query, and stopped through systemctl"

# ---------------------------------------------------------------- marker data
log "== record the Agents' durable work before maintenance =="
MARKER_ONE="$MARKERS/$AGENT_ONE.json"
"$NODE" "$HARNESS" marker --release "$RELEASE" --store "$DATA/state/mate.sqlite" \
  --agent "$AGENT_ONE" --secondAgent "$AGENT_TWO" --out "$MARKER_ONE" >"$WORK/marker.json" ||
  fail marker-data "could not record the Agents' durable work"
phase marker-data passed "identity, session, message, task, reminder and delivery recorded for $AGENT_ONE and $AGENT_TWO"

# ---------------------------------------------------------------- backup and restore
log "== backup, verify the checkpoint, then restore it =="
systemctl stop mate.service >/dev/null 2>&1 || true
matectl=/usr/local/sbin/matectl
[ -x "$matectl" ] || die "matectl is not installed at $matectl"
rm -rf "$TARGET_CHECKPOINT" "$CURRENT_CHECKPOINT"
"$matectl" backup target-state >"$WORK/backup.log" 2>&1 ||
  fail backup "matectl backup failed: $(cat "$WORK/backup.log")"
verify_marker "$MARKER_ONE" "$TARGET_CHECKPOINT" >"$WORK/verify-checkpoint.json" ||
  fail backup "checkpoint verification failed: $(cat "$WORK/verify-checkpoint.json")"
phase backup passed "matectl backup published a checkpoint whose manifest, payload and marker data verify"

# The shared root is outside the checkpoint by design: an ordinary file-level backup carries it.
cp -a "$SHARED" "$WORK/shared-backup"
[ "$(stat -c '%u %g' "$WORK/shared-backup/$AGENT_TWO")" = "$UID_TWO $GID_TWO" ] ||
  fail shared-backup "the shared-directory file backup did not keep $AGENT_TWO's UID/GID"
[ "$(cat "$WORK/shared-backup/$AGENT_TWO/validation.txt")" = "agent-two shared note" ] ||
  fail shared-backup "the shared-directory file backup did not keep $AGENT_TWO's content"
[ "$(stat -c '%u %g' "$WORK/shared-backup/$AGENT_ONE")" = "$UID_ONE $GID_ONE" ] ||
  fail shared-backup "the shared-directory file backup did not keep $AGENT_ONE's UID/GID"
phase shared-backup passed "an ordinary file-level copy of the shared root kept each Agent's UID/GID and content"

# Change the monitored private file BEFORE the current-state checkpoint. `restore --replace CURRENT`
# requires CURRENT to describe the live state, and that comparison covers the private home, so a
# change made after CURRENT was taken would (correctly) make the restore refuse to run.
printf 'native validation change after the target checkpoint\n' >>"$HOME_ONE/notes/validation.txt"
chown "$UID_ONE:$GID_ONE" "$HOME_ONE/notes/validation.txt"
[ "$(cat "$HOME_ONE/notes/validation.txt")" = "agent-one private note
native validation change after the target checkpoint" ] ||
  fail restore "could not stage the post-target-checkpoint change"
"$matectl" backup current-state >"$WORK/backup-current.log" 2>&1 ||
  fail backup "the second matectl backup failed: $(cat "$WORK/backup-current.log")"
"$matectl" restore target-state --replace current-state >"$WORK/restore.log" 2>&1 ||
  fail restore "matectl restore failed: $(cat "$WORK/restore.log")"
# Verify the restored database against the target checkpoint and the restored private home against
# the checkpoint's own inventory, so content, type, mode and layout are compared entry by entry.
verify_marker "$MARKER_ONE" "$TARGET_CHECKPOINT" "$HOME_ONE" >"$WORK/verify-restore.json" ||
  fail restore "restored data differs from the marker: $(cat "$WORK/verify-restore.json")"
[ "$(stat -c '%u %g %a' "$HOME_ONE")" = "$UID_ONE $GID_ONE 700" ] ||
  fail restore "the restored private home has the wrong owner or mode"
[ "$(stat -c '%u %g %a' "$HOME_ONE/notes/validation.txt")" = "$UID_ONE $GID_ONE 600" ] ||
  fail restore "the restored private file has the wrong owner or mode"
[ "$(cat "$HOME_ONE/notes/validation.txt")" = "agent-one private note" ] ||
  fail restore "the appended post-checkpoint line survived the restore, so state was not replaced"
phase restore passed "matectl restore replaced the modified private file with the checkpoint's content, owner and mode"

# A checkpoint that no longer matches its manifest must be refused, not silently applied.
TAMPERED_CHECKPOINT="$WORK/tampered-checkpoint"
cp -a "$TARGET_CHECKPOINT" "$TAMPERED_CHECKPOINT"
printf 'tampered\n' >>"$TAMPERED_CHECKPOINT/agents/$AGENT_ONE/MEMORY.md"
if verify_marker "$MARKER_ONE" "$TAMPERED_CHECKPOINT" >/dev/null 2>&1; then
  fail tamper-refusal "a checkpoint whose payload changed passed verification"
fi
if "$matectl" restore "$TAMPERED_CHECKPOINT" >/dev/null 2>&1; then
  fail tamper-refusal "matectl restore accepted a path outside the managed checkpoint directory"
fi
phase tamper-refusal passed "a changed checkpoint fails verification, and a non-managed path is refused"

# ---------------------------------------------------------------- program upgrade, config change, restart
log "== program upgrade within the same first-release format =="
systemctl stop mate.service >/dev/null 2>&1 || true
RELEASE_BEFORE=$(readlink -f /opt/mate/current)
if [ -n "${NEXT_SPEC-}" ]; then
  [ -f "$NEXT_SPEC" ] || die "No candidate spec at $NEXT_SPEC"
  # The candidate is a different built release, and the upgrade goes through the installed wrapper
  # the operating instructions name: `matectl upgrade SPEC`. The project's own guard refuses a
  # candidate that is already current, so a successful switch proves a program-version change.
  "$matectl" upgrade "$NEXT_SPEC" >"$WORK/upgrade.json" 2>&1 ||
    fail program-upgrade "matectl upgrade failed: $(cat "$WORK/upgrade.json")"
  "$matectl" finalize >"$WORK/finalize.json" 2>&1 ||
    fail program-upgrade "matectl finalize failed: $(cat "$WORK/finalize.json")"
  RELEASE_AFTER=$(readlink -f /opt/mate/current)
  [ "$RELEASE_AFTER" != "$RELEASE_BEFORE" ] ||
    fail program-upgrade "the current release did not change, so no program version was installed"
else
  # Without a second release, assert the documented refusal rather than pretending to upgrade.
  if "$NODE" "$RELEASE/dist/src/deployment/cli.js" upgrade "$SPEC" >"$WORK/upgrade.json" 2>&1; then
    fail program-upgrade "upgrading to the already current release was accepted"
  fi
  grep -q "already the current release" "$WORK/upgrade.json" ||
    fail program-upgrade "the same-release upgrade failed for an unexpected reason: $(cat "$WORK/upgrade.json")"
  RELEASE_AFTER=$RELEASE_BEFORE
  phase program-upgrade passed "the installed guard refused re-installing the current release; pass a second spec to validate a real version change"
fi
systemctl start mate.service
await_service program-upgrade
systemctl stop mate.service >/dev/null 2>&1 || true
verify_marker "$MARKER_ONE" >"$WORK/verify-upgrade.json" ||
  fail program-upgrade "records changed across the program upgrade: $(cat "$WORK/verify-upgrade.json")"
# The restart after a program-version change must leave the Agent's Linux identity and private
# directory exactly as they were.
expect_owner agent-private-home-after-upgrade "$HOME_ONE" "$UID_ONE" "$GID_ONE" 700
if [ -n "${NEXT_SPEC-}" ]; then
  phase program-upgrade passed "release $RELEASE_BEFORE became $RELEASE_AFTER and every recorded session, delivery, task, reminder and identity survived"
fi

log "== configuration change in the same format =="
CONFIG_NEXT="$WORK/mate.next.json"
"$NODE" -e '
  const fs=require("fs");const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  c.mate.runTimeoutMs=(c.mate.runTimeoutMs??60000)+1000;
  fs.writeFileSync(process.argv[2],JSON.stringify(c,null,2)+"\n",{mode:0o600})' "$CONFIG" "$CONFIG_NEXT"
install -o root -g root -m 600 "$CONFIG_NEXT" /etc/mate/mate.json
systemctl start mate.service
await_service configuration-change
# Give Mate one clean start to apply and record the changed configuration, then stop it again.
"$SLEEP" 2
systemctl stop mate.service >/dev/null 2>&1 || true
# The configuration row must have been rewritten to the new configuration; every other recorded row
# must be untouched. Checking only the first half would pass when the change was never applied.
verify_marker "$MARKER_ONE" "" "" applied /etc/mate/mate.json >"$WORK/verify-config.json" ||
  fail configuration-change "records changed across the configuration change: $(cat "$WORK/verify-config.json")"
expect_owner mate-configuration-file-still-managed /etc/mate/mate.json 0 0 600
expect_owner agent-private-home-after-config-change "$HOME_ONE" "$UID_ONE" "$GID_ONE" 700
phase configuration-change passed "Mate applied and recorded the changed configuration while keeping the recorded work and identity"

# ---------------------------------------------------------------- report
log "== report =="
MATE_RELEASE_BEFORE=$RELEASE_BEFORE
MATE_RELEASE_AFTER=${RELEASE_AFTER-}
export MATE_RELEASE_BEFORE MATE_RELEASE_AFTER
write_attestation
DOCUMENT="$WORK/mate-maintenance-validation.json"
"$NODE" "$HARNESS" report --mode native --phases "$PHASES" --attest "$WORK/attestation.json" \
  --out "$DOCUMENT" >/dev/null
install -o root -g root -m 600 "$DOCUMENT" /var/tmp/mate-maintenance-validation.json
cat "$DOCUMENT"
log "Evidence copied to /var/tmp/mate-maintenance-validation.json"
log "Native checks are complete. Slack, model-provider and VPS connections were NOT tested."
