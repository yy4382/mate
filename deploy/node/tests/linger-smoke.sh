#!/bin/sh
set -eu
# An external observer, outside the Mate account's login sessions, reads actual
# host facts. It never runs Mate as root, logs in as the owner, or changes linger.
phase=${1:?before-logout|after-logout|after-boot UID HOME IDENTITY_FILE SNAPSHOT}
target_uid=${2:?}
target_home=${3:?}
identity=${4:?}
snapshot=${5:?}
case "$phase" in before-logout|after-logout|after-boot) ;; *) echo 'Unknown linger observation phase' >&2; exit 1 ;; esac
case "$target_uid" in ''|*[!0-9]*) echo 'UID must be a nonzero number' >&2; exit 1 ;; esac
[ "$target_uid" -gt 0 ]
[ "$(id -u)" != "$target_uid" ] || { echo 'Run this observer outside the Mate account; a new owner login invalidates the test' >&2; exit 1; }
[ "$(uname -s)" = Linux ]
virtualization=$(systemd-detect-virt --container 2>/dev/null || :)
[ "$virtualization" = none ] || { echo 'Linger acceptance requires a real host/VM, not a container' >&2; exit 1; }
account_home=$(getent passwd "$target_uid" | awk -F: '{print $6}')
account_name=$(getent passwd "$target_uid" | awk -F: '{print $1}')
[ -n "$account_home" ] && [ "$(readlink -f "$account_home")" = "$(readlink -f "$target_home")" ] || { echo 'Use the existing target account home' >&2; exit 1; }
[ "$(loginctl show-user "$target_uid" -p Linger --value)" = yes ] || { echo 'Linger must already be configured by the user; this test never enables it' >&2; exit 1; }
sessions=$(loginctl show-user "$target_uid" -p Sessions --value)
unit="$target_home/.config/systemd/user/mate-node.service"
[ -f "$unit" ] && [ ! -L "$unit" ]
[ "$(stat -c %u "$unit")" = "$target_uid" ]
[ "$(readlink -f "$target_home/.config/systemd/user/default.target.wants/mate-node.service")" = "$(readlink -f "$unit")" ] || { echo 'Mate service must already be enabled' >&2; exit 1; }
manager_pid=$(systemctl show "user@$target_uid.service" -p MainPID --value)
[ "$manager_pid" -gt 0 ]
manager_group=$(systemctl show "user@$target_uid.service" -p ControlGroup --value)
case "$manager_group" in /user.slice/*) ;; *) echo 'Unexpected user-manager cgroup' >&2; exit 1 ;; esac
groups=$(find "/sys/fs/cgroup$manager_group" -type d -name mate-node.service)
[ "$(printf '%s\n' "$groups" | wc -l | tr -d ' ')" = 1 ] && [ -n "$groups" ]
node_pid=$(cat "$groups/cgroup.procs")
# Run this probe with an idle node; child commands make the observation ambiguous.
case "$node_pid" in ''|*[!0-9]*) echo 'Expected exactly one idle node process in its service cgroup' >&2; exit 1 ;; esac
[ "$(stat -c %u "/proc/$node_pid")" = "$target_uid" ]
runtime=$(readlink -f "/proc/$node_pid/exe")
case "$runtime" in "$target_home"/.local/lib/mate-node/versions/*/node/bin/node) ;; *) echo 'Service is not running the installed dedicated runtime' >&2; exit 1 ;; esac
boot_id=$(cat /proc/sys/kernel/random/boot_id)
unit_sha=$(sha256sum "$unit" | awk '{print $1}')
identity_sha=$(sha256sum "$identity" | awk '{print $1}')
manager_start=$(awk '{print $22}' "/proc/$manager_pid/stat")
node_start=$(awk '{print $22}' "/proc/$node_pid/stat")
fact() { awk -F= -v key="$1" '$1==key {sub(/^[^=]*=/, ""); print}' "$snapshot"; }
facts() {
  printf 'uid=%s\nboot=%s\nmanager=%s\nmanager_start=%s\nnode=%s\nnode_start=%s\nunit=%s\nidentity=%s\nruntime=%s\n' \
    "$target_uid" "$boot_id" "$manager_pid" "$manager_start" "$node_pid" "$node_start" "$unit_sha" "$identity_sha" "$runtime"
}
case "$phase" in
  before-logout)
    [ -n "$sessions" ] || { echo 'No actual owner login to log out of' >&2; exit 1; }
    [ ! -e "$snapshot" ] && [ ! -L "$snapshot" ]
    umask 077
    (set -C; facts > "$snapshot")
    printf 'Observed owner sessions before logout: %s\n' "$sessions"
    ;;
  after-logout|after-boot)
    [ -z "$sessions" ] || { echo 'Owner still has login sessions; cannot prove linger logout/boot behavior' >&2; exit 1; }
    [ -f "$snapshot" ] && [ ! -L "$snapshot" ]
    [ "$(fact uid)" = "$target_uid" ]
    [ "$(fact unit)" = "$unit_sha" ] && [ "$(fact identity)" = "$identity_sha" ]
    [ "$(fact runtime)" = "$runtime" ]
    if [ "$phase" = after-logout ]; then
      [ "$(fact boot)" = "$boot_id" ]
      [ "$(fact manager)" = "$manager_pid" ] && [ "$(fact manager_start)" = "$manager_start" ]
      [ "$(fact node)" = "$node_pid" ] && [ "$(fact node_start)" = "$node_start" ]
      [ ! -e "$snapshot.logout" ] && [ ! -L "$snapshot.logout" ]
      umask 077
      (set -C; facts > "$snapshot.logout")
    else
      [ -f "$snapshot.logout" ] && [ ! -L "$snapshot.logout" ]
      [ "$(awk -F= '$1=="uid" {print $2}' "$snapshot.logout")" = "$target_uid" ]
      [ "$(awk -F= '$1=="boot" {print $2}' "$snapshot.logout")" = "$(fact boot)" ]
      [ "$(fact boot)" != "$boot_id" ] || { echo 'Host has not booted again' >&2; exit 1; }
      # Empty current sessions alone would allow login -> logout after boot.
      # Require full system-journal access and no logind session for this owner
      # anywhere in this boot, before reading the already running service.
      [ "$(id -u)" = 0 ] || { echo 'After-boot observation needs the existing external VM supervisor with full journal access; it never executes Mate' >&2; exit 1; }
      startup_journal=$(journalctl --system --boot=0 --quiet _SYSTEMD_UNIT=systemd-logind.service -n 1 --output=cat)
      [ -n "$startup_journal" ] || { echo 'No complete boot logind evidence available' >&2; exit 1; }
      owner_sessions=$(journalctl --system --boot=0 --quiet _SYSTEMD_UNIT=systemd-logind.service "USER_ID=$account_name" --field=SESSION_ID)
      [ -z "$owner_sessions" ] || { echo 'Owner already logged in during this boot; cannot claim boot-triggered startup' >&2; exit 1; }
    fi
    printf 'PASS: %s with no owner login sessions, existing linger, enabled service, dedicated runtime and unchanged identity/unit\n' "$phase"
    ;;
esac
facts
