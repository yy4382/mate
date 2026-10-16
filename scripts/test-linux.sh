#!/bin/sh
# Run the Linux-only test suites (apps/node by default) in a Linux container, as the non-root
# `node` account. Arguments go to vitest, e.g. `pnpm test:linux apps/node/test/commands.test.ts`.
# The repo is mounted read-only and copied into a container volume, where dependencies are
# installed for Linux; the host's node_modules are never used. The relaxed seccomp and /proc/sys
# options let the PID-reuse test choose PIDs in an unprivileged user and PID namespace.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
image=mate-test-linux
docker build --quiet --tag "$image" --file "$root/scripts/linux-test.Dockerfile" "$root/scripts" >/dev/null
[ "$#" -gt 0 ] || set -- apps/node
exec docker run --rm --init \
  --security-opt seccomp=unconfined --security-opt systempaths=unconfined \
  --volume "$root:/src:ro" \
  --volume mate-test-linux-work:/work \
  --volume mate-test-linux-store:/home/node/.pnpm-store \
  "$image" sh -ec '
    find /work -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
    tar -C /src --exclude=./.git --exclude=node_modules --exclude=./.pnpm-store \
      --exclude=./.worktrees --exclude=dist -cf - . | tar -C /work -xf -
    pnpm install --frozen-lockfile --prefer-offline --store-dir /home/node/.pnpm-store \
      --reporter=silent
    exec pnpm exec vitest run "$@"
  ' test-linux "$@"
