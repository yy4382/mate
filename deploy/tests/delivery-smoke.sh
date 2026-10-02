#!/bin/sh
set -eu
# Runs the acceptance driver with the delivered runtime, never a host Node.
image=${1:?IMAGE ARCHIVE BOOTSTRAP SHA256 VERSION}
archive=$(realpath "${2:?}")
bootstrap=$(realpath "${3:?}")
digest=${4:?}
version=${5:?}
daemon_recovery=${6:-}
case "$daemon_recovery" in ''|--docker-daemon-recovery) ;; *) echo 'Unknown delivery option' >&2; exit 1 ;; esac
[ "$(uname -s)" = Linux ] || { echo 'Delivery acceptance requires a Linux host' >&2; exit 1; }
[ "$(id -u)" -gt 0 ] && [ "$(id -g)" -gt 0 ] || { echo 'Use an existing ordinary account' >&2; exit 1; }
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
directory=$(mktemp -d "${TMPDIR:-/tmp}/mate-delivery-XXXXXX")
chmod 700 "$directory"
mkdir -m 700 "$directory/home"
export HOME="$directory/home"
printf 'Delivery evidence retained at %s\n' "$directory"
sh "$bootstrap" --version "$version" --package "$archive" --sha256 "$digest"
bundle="$HOME/.local/lib/mate-node/versions/$version"
"$HOME/.local/bin/mate" --version
exec "$bundle/node/bin/node" "$root/deploy/tests/delivery.mjs" "$image" "$bundle" "$directory" "$version" "$archive" "$root" "$daemon_recovery"
