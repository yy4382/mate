#!/bin/bash
set -euo pipefail

: "${PALACE_APPLE_TEAM_ID:?Set PALACE_APPLE_TEAM_ID to your Apple Team ID}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
release_commit="$(git rev-parse HEAD)"
mkdir -p "$repo_root/artifacts/ios"
release_dir="$(mktemp -d "$repo_root/artifacts/ios/release.XXXXXX")"
release_source="$release_dir/source"
archive_path="$release_dir/Palace.xcarchive"
mkdir -p "$release_source"
git archive "$release_commit" | tar -xf - -C "$release_source"
printf '%s\n' "$release_commit" > "$release_dir/commit.txt"
printf 'Release directory: %s\n' "$release_dir"

cd "$release_source"
pnpm install --frozen-lockfile
export PALACE_IOS_APNS_ENVIRONMENT=production
pnpm --filter @palace/mobile exec expo config --type public --json \
  > "$release_dir/app-config.json"
pnpm --filter @palace/mobile exec expo prebuild --platform ios --no-install

palace_node_binary="$(pnpm exec node -p 'process.execPath')"
palace_node_directory="$(dirname "$palace_node_binary")"
export PATH="$palace_node_directory:$PATH"
cd apps/mobile/ios
pod install

# Expo reads these files again when Xcode embeds the app configuration.
printf '%s\n' 'export PALACE_IOS_APNS_ENVIRONMENT=production' > .xcode.env
printf 'export PATH="%s:$PATH"\nexport NODE_BINARY="%s"\n' \
  "$palace_node_directory" "$palace_node_binary" > .xcode.env.local

cp Podfile.lock "$release_dir/Podfile.lock"
{
  xcodebuild -version
  printf 'CocoaPods '
  pod --version
  printf 'Node '
  "$palace_node_binary" --version
  printf 'pnpm '
  pnpm --version
} > "$release_dir/toolchain.txt"

xcodebuild archive \
  -workspace Palace.xcworkspace \
  -scheme Palace \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$archive_path" \
  -derivedDataPath "$release_dir/DerivedData" \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$PALACE_APPLE_TEAM_ID" \
  CODE_SIGN_STYLE=Automatic \
  2>&1 | tee "$release_dir/archive.log"

cd "$release_source/apps/mobile"
react_native_version="$(node -p 'require("react-native/package.json").version')"
hermes_version="$(sed -n 's/^HERMES_VERSION_NAME=//p' node_modules/react-native/sdks/hermes-engine/version.properties)"
react_native_url="https://repo1.maven.org/maven2/com/facebook/react/react-native-artifacts/$react_native_version/react-native-artifacts-$react_native_version"
hermes_url="https://repo1.maven.org/maven2/com/facebook/hermes/hermes-ios/$hermes_version/hermes-ios-$hermes_version"
symbols_dir="$release_dir/symbols"
frameworks_dir="$archive_path/Products/Applications/Palace.app/Frameworks"
mkdir -p "$symbols_dir"

while read -r framework device_path url; do
  curl --fail --location "$url" --output "$symbols_dir/$framework.tar.gz"
  tar -xzf "$symbols_dir/$framework.tar.gz" -C "$symbols_dir" "$device_path"
  dsym_path="$symbols_dir/$device_path"
  binary_uuids="$(xcrun dwarfdump --uuid "$frameworks_dir/$framework.framework/$framework" | awk '{print $2, $3}' | sort)"
  symbol_uuids="$(xcrun dwarfdump --uuid "$dsym_path" | awk '{print $2, $3}' | sort)"
  if [[ "$binary_uuids" != "$symbol_uuids" ]]; then
    printf 'dSYM UUID mismatch for %s\n' "$framework" >&2
    exit 1
  fi
  cp -R "$dsym_path" "$archive_path/dSYMs/"
done <<EOF
React ./ios-arm64/React.framework.dSYM $react_native_url-reactnative-core-dSYM-release.tar.gz
ReactNativeDependencies ./ios-arm64/ReactNativeDependencies.framework.dSYM $react_native_url-reactnative-dependencies-dSYM-release.tar.gz
hermesvm ./iphoneos/hermesvm.framework.dSYM $hermes_url-hermes-framework-dSYM-release.tar.gz
EOF

printf '\nArchive ready: %s\n' "$archive_path"
printf 'Open this archive in Xcode Organizer and confirm the upload.\n'
