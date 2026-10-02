#!/bin/sh
# This runs only on the named target Linux system, as its existing ordinary user.
set -eu
bundle=$1
bootstrap=$2
checksum=$3
version=$4
fixtures=${5:-}
test "$(id -u)" != 0
case "$(uname -m)" in aarch64|x86_64) ;; *) exit 1 ;; esac
if command -v node >/dev/null 2>&1; then
  echo 'This acceptance run requires no system Node in PATH.' >&2
  exit 1
fi
test_home=$(mktemp -d)
trap 'rm -rf "$test_home"' EXIT HUP INT TERM
export HOME=$test_home
export GH_TOKEN=synthetic-download-secret
sh "$bootstrap" --version "$version" --package "$bundle" --sha256 "$checksum"
test "$("$HOME/.local/bin/mate" --version)" = "$version"
test ! -e "$HOME/.config/mate"
test ! -e "$HOME/.config/systemd/user/mate-node.service"
test ! -e "$HOME/.local/share/mate"
sh "$bootstrap" --version "$version" --package "$bundle" --sha256 "$checksum"
test "$("$HOME/.local/bin/mate" --version)" = "$version"
old_entry=$(readlink "$HOME/.local/bin/mate")
if sh "$bootstrap" --version 99.0.0 --package "$bundle" --sha256 "$checksum"; then exit 1; fi
test "$(readlink "$HOME/.local/bin/mate")" = "$old_entry"
if [ -n "$fixtures" ]; then
  for name in wrong-architecture wrong-runtime corrupt-file unsafe-link; do
    if sh "$bootstrap" --version "$version" --package "$fixtures/$name.tar.gz" --sha256 "$(cat "$fixtures/$name.tar.gz.sha256")"; then exit 1; fi
    test "$(readlink "$HOME/.local/bin/mate")" = "$old_entry"
  done
  export MATE_TEST_ASSET=$bundle
  export MATE_TEST_CHECKSUMS=$(dirname "$bundle")/SHA256SUMS
  PATH="$fixtures:$PATH" sh "$bootstrap" --version "$version"
  test "$("$HOME/.local/bin/mate" --version)" = "$version"
fi
mkdir -p "$HOME/.config/systemd/user"
printf '# Mate node service\n# Mate bundle version: %s\n[Service]\nExecStart="%s/node/bin/node" "%s/app/apps/node/dist/main.js"\n' "$version" "$HOME/.local/lib/mate-node/versions/$version" "$HOME/.local/lib/mate-node/versions/$version" > "$HOME/.config/systemd/user/mate-node.service"
cp "$HOME/.config/systemd/user/mate-node.service" "$test_home/unit-before"
rm "$HOME/.local/bin/mate"
sh "$bootstrap" --version "$version" --package "$bundle" --sha256 "$checksum"
cmp "$HOME/.config/systemd/user/mate-node.service" "$test_home/unit-before"
printf '# Mate node service\n# Mate bundle version: 99.0.0\n' > "$HOME/.config/systemd/user/mate-node.service"
if sh "$bootstrap" --version "$version" --package "$bundle" --sha256 "$checksum"; then exit 1; fi
test "$("$HOME/.local/bin/mate" --version)" = "$version"
rm "$HOME/.config/systemd/user/mate-node.service"
if sh "$bootstrap" --version "$version" --package "$bundle" --sha256 0000000000000000000000000000000000000000000000000000000000000000; then exit 1; fi
test "$("$HOME/.local/bin/mate" --version)" = "$version"
rm "$HOME/.local/bin/mate"
printf 'unrelated program\n' > "$HOME/.local/bin/mate"
if sh "$bootstrap" --version "$version" --package "$bundle" --sha256 "$checksum"; then exit 1; fi
test "$(cat "$HOME/.local/bin/mate")" = 'unrelated program'
rm "$HOME/.local/bin/mate"
chmod 500 "$HOME/.local/bin"
if sh "$bootstrap" --version "$version" --package "$bundle" --sha256 "$checksum"; then exit 1; fi
chmod 700 "$HOME/.local/bin"
printf 'damaged installed file\n' > "$HOME/.local/lib/mate-node/versions/$version/app/apps/node/dist/main.js"
if sh "$bootstrap" --version "$version" --package "$bundle" --sha256 "$checksum"; then exit 1; fi
test ! -e "$HOME/.local/bin/mate"
if grep -R 'synthetic-download-secret' "$HOME/.local" "$HOME/.config" >/dev/null 2>&1; then exit 1; fi
echo "PASS bootstrap/CLI on $(. /etc/os-release; echo "$ID $VERSION_ID") $(uname -m), UID=$(id -u); no system Node; service lifecycle not tested."
