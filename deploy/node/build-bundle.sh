#!/bin/sh
set -eu
version=${1:-}
architecture=${2:-}
output=${3:-dist/node-bundles}
printf '%s\n' "$version" | LC_ALL=C grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?$' || { echo 'Usage: build-bundle.sh VERSION x64|arm64 [OUTPUT]' >&2; exit 1; }
case "$architecture" in x64) platform=linux/amd64 ;; arm64) platform=linux/arm64 ;; *) echo 'Only x64 and arm64 bundles are supported' >&2; exit 1 ;; esac
docker buildx build --platform "$platform" --file deploy/node/Dockerfile --build-arg "MATE_VERSION=$version" --target artifact --output "type=local,dest=$output" .
asset="mate-node-$version-linux-$architecture.tar.gz"
# macOS build machines have shasum; Linux build machines normally have sha256sum.
if command -v sha256sum >/dev/null 2>&1; then
  digest=$(sha256sum "$output/$asset" | awk '{print $1}')
else
  digest=$(shasum -a 256 "$output/$asset" | awk '{print $1}')
fi
printf '%s  %s\n' "$digest" "$asset" > "$output/$asset.sha256"
cat "$output"/mate-node-"$version"-linux-*.tar.gz.sha256 > "$output/SHA256SUMS"
cp deploy/node/bootstrap.sh "$output/bootstrap.sh"
echo "Local release assets: $output/$asset, $output/SHA256SUMS, $output/bootstrap.sh"
