#!/bin/sh
set -eu
entry=$(readlink -f "$0")
bundle=$(dirname "$(dirname "$entry")")
if [ "$#" -ge 2 ] && [ "$1" = node ] && [ "$2" = update ]; then
  # Only acquisition may receive temporary download authentication. Runtime/service children remove it.
  exec "$bundle/node/bin/node" "$bundle/app/apps/node/dist/management/cli.js" "$@"
fi
exec env -u GH_TOKEN -u GITHUB_TOKEN -u GH_ENTERPRISE_TOKEN -u GITHUB_ENTERPRISE_TOKEN \
  "$bundle/node/bin/node" "$bundle/app/apps/node/dist/management/cli.js" "$@"
