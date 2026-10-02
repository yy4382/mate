#!/bin/sh
set -eu
entry=$(readlink -f "$0")
bundle=$(dirname "$(dirname "$entry")")
exec env -u GH_TOKEN -u GITHUB_TOKEN -u GH_ENTERPRISE_TOKEN -u GITHUB_ENTERPRISE_TOKEN \
  "$bundle/node/bin/node" "$bundle/app/apps/node/dist/management/cli.js" "$@"
