#!/bin/sh
# Supplemental package checks; these containers do not prove systemd user services.
set -eu
version=$1
architecture=$2
output=${3:-dist/node-bundles}
case "$architecture" in x64) platform=linux/amd64 ;; arm64) platform=linux/arm64 ;; *) exit 1 ;; esac
asset="mate-node-$version-linux-$architecture.tar.gz"
checksum=$(awk -v file="$asset" '$2 == file {print $1}' "$output/SHA256SUMS")
fixtures="/tmp/mate-b-134-fixtures-$architecture-$$"
trap 'rm -rf "$fixtures"' EXIT HUP INT TERM
node deploy/node/tests/prepare-fixtures.mjs "$output/$asset" "$fixtures"
for system in ubuntu:24.04 debian:13; do
  docker run --rm --name "mate-b-134-$architecture-$(echo "$system" | tr ':.' '--')" --platform "$platform" \
    --user "$(id -u):$(id -g)" --network none --read-only --tmpfs /tmp:rw,exec,mode=1777 \
    --mount "type=bind,src=$(cd "$output" && pwd),dst=/assets,readonly" \
    --mount "type=bind,src=$(pwd)/deploy/node/tests,dst=/tests,readonly" \
    --mount "type=bind,src=$fixtures,dst=/fixtures,readonly" \
    "$system" sh /tests/bundle-smoke.sh "/assets/$asset" /assets/bootstrap.sh "$checksum" "$version" /fixtures
done
docker run --rm --name "mate-b-134-interruption-$architecture" --platform "$platform" \
  --user "$(id -u):$(id -g)" --network none --read-only --tmpfs /tmp:rw,exec,mode=1777 \
  --mount "type=bind,src=$(cd "$output" && pwd),dst=/assets,readonly" \
  --mount "type=bind,src=$(pwd)/deploy/node/tests,dst=/tests,readonly" \
  ubuntu:24.04 sh /tests/interruption-smoke.sh "/assets/$asset" "$version"
docker run --rm --name "mate-b-134-root-$architecture" --platform "$platform" \
  --user 0:0 --network none --read-only --tmpfs /tmp:rw,exec,mode=1777 \
  --mount "type=bind,src=$(cd "$output" && pwd),dst=/assets,readonly" \
  ubuntu:24.04 sh -eu -c '
    tar -xzf "$1" -C /tmp
    if /tmp/mate-node/bin/mate --version >/tmp/cli-result 2>&1; then exit 1; fi
    grep "never root" /tmp/cli-result
    if sh /assets/bootstrap.sh --version "$2" --package "$1" --sha256 "$3" >/tmp/bootstrap-result 2>&1; then exit 1; fi
    grep "never root" /tmp/bootstrap-result
  ' sh "/assets/$asset" "$version" "$checksum"
