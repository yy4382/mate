#!/bin/sh
# Acquisition only. The package's CLI owns all installed files and service decisions.
set -eu
die() {
  printf 'Mate bootstrap: %s\n' "$1" >&2
  exit 1
}

version=
package=
checksum=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version|--package|--sha256)
      [ "$#" -ge 2 ] || die 'Missing argument value'
      case "$1" in
        --version) version=$2 ;;
        --package) package=$2 ;;
        --sha256) checksum=$2 ;;
      esac
      shift 2
      ;;
    *) die 'Usage: bootstrap.sh --version VERSION [--package FILE --sha256 SHA256]' ;;
  esac
done

printf '%s\n' "$version" | LC_ALL=C grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?$' || die 'An explicit release version is required'
[ "$(id -u)" != 0 ] || die 'Use the existing ordinary account, never root'
[ "$(uname -s)" = Linux ] || die 'Only Linux glibc packages are supported'
case "$(uname -m)" in
  x86_64) architecture=x64 ;;
  aarch64) architecture=arm64 ;;
  *) die 'Only x86_64 and arm64 are supported' ;;
esac

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT HUP INT TERM
asset="mate-node-$version-linux-$architecture.tar.gz"
if [ -n "$package" ]; then
  [ -n "$checksum" ] || die 'Local packages require the release SHA-256 value'
  cp -- "$package" "$stage/$asset" || die 'Cannot read local package'
else
  [ -z "$checksum" ] || die 'Use the release checksums when downloading'
  command -v gh >/dev/null 2>&1 || die 'Authenticated download requires gh; alternatively supply a local package and SHA-256'
  [ -n "${GH_TOKEN:-}" ] || [ -n "${GITHUB_TOKEN:-}" ] || die 'Supply a temporary GH_TOKEN for this private release download'
  # Never emit downloader diagnostics, which can contain authentication details.
  gh release download "v$version" \
    --repo yy4382/mate \
    --pattern "$asset" \
    --pattern SHA256SUMS \
    --dir "$stage" >/dev/null 2>&1 || die 'Private release download failed; check the explicit version and temporary authentication'
  checksum=$(awk -v file="$asset" '$2 == file { print $1 }' "$stage/SHA256SUMS")
fi

printf '%s\n' "$checksum" | LC_ALL=C grep -Eq '^[a-f0-9]{64}$' || die 'Invalid release SHA-256 value'
actual=$(sha256sum "$stage/$asset" | awk '{print $1}')
[ "$actual" = "$checksum" ] || die 'Package SHA-256 mismatch'

# Permit only regular files and directories. No links, devices, absolute paths or traversal.
tar -tzf "$stage/$asset" > "$stage/names" 2>/dev/null || die 'Invalid package archive'
LC_ALL=C awk '
  /^\// || /(^|\/)\.\.(\/|$)/ || /(^|\/)\.(\/|$)/ { exit 1 }
  $0 !~ /^mate-node\// { exit 1 }
  END { if (NR == 0) exit 1 }
' "$stage/names" || die 'Unsafe package archive path'
tar -tvzf "$stage/$asset" > "$stage/modes" 2>/dev/null || die 'Invalid package archive'
LC_ALL=C awk 'substr($0,1,1) != "-" && substr($0,1,1) != "d" { exit 1 }' "$stage/modes" || die 'Package links or special files are forbidden'

mkdir "$stage/unpacked"
tar -xzf "$stage/$asset" -C "$stage/unpacked" --no-same-owner --no-same-permissions 2>/dev/null || die 'Package extraction failed'
bundle="$stage/unpacked/mate-node"
[ -x "$bundle/node/bin/node" ] && [ -f "$bundle/app/apps/node/dist/management/cli.js" ] || die 'Package lacks dedicated Node or CLI'
env -u GH_TOKEN -u GITHUB_TOKEN -u GH_ENTERPRISE_TOKEN -u GITHUB_ENTERPRISE_TOKEN \
  "$bundle/node/bin/node" "$bundle/app/apps/node/dist/management/cli.js" --bootstrap-install "$bundle" "$version"
