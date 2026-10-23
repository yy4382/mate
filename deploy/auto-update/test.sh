#!/bin/sh
# Check mate-deploy's upgrade and rollback paths in a clean x86_64 Debian 13 container (MODULE_TESTS §13.1).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
exec docker run --rm --platform linux/amd64 --volume "$here:/t:ro" debian:13 bash /t/test/run.sh
