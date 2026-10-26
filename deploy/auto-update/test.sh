#!/bin/sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
exec docker run --rm --platform linux/amd64 --volume "$here:/t:ro" debian:13 bash /t/test/run.sh
