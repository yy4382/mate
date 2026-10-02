#!/bin/sh
# Real CLI/filesystem/rename primitive, in an ordinary account's throwaway HOME.
set -eu
archive=$1
version=$2
test "$(id -u)" != 0
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT HUP INT TERM
mkdir "$stage/source" "$stage/home"
tar -xzf "$archive" -C "$stage/source"
bundle="$stage/source/mate-node"
runtime="$bundle/node/bin/node"
cli="$bundle/app/apps/node/dist/management/cli.js"
export HOME=$stage/home
"$runtime" "$cli" --bootstrap-install "$bundle" "$version" > "$stage/interrupted.log" 2>&1 &
pid=$!
killed=no
while kill -0 "$pid" 2>/dev/null; do
  for directory in "$HOME"/.local/lib/mate-node/versions/.install-*; do
    if [ -f "$directory/.mate-install-stage" ] && [ -f "$directory/app/apps/node/dist/main.js" ]; then
      kill -KILL "$pid"
      killed=yes
      break
    fi
  done
  [ "$killed" = no ] || break
done
[ "$killed" = yes ] || { cat "$stage/interrupted.log" >&2; echo 'Did not reach a live copy interruption point' >&2; exit 1; }
if wait "$pid"; then exit 1; fi
"$runtime" "$cli" --bootstrap-install "$bundle" "$version"
for directory in "$HOME"/.local/lib/mate-node/versions/.install-*; do test ! -e "$directory"; done
test "$("$HOME/.local/bin/mate" --version)" = "$version"
echo 'PASS actual CLI SIGKILL during staging; retry removed the interrupted stage and installed a complete bundle.'

# A concurrent non-Mate file appears after preflight, while the bundle is copying.
mkdir "$stage/race-home"
export HOME=$stage/race-home
printf 'concurrent unrelated entry\n' > "$stage/foreign"
"$runtime" "$cli" --bootstrap-install "$bundle" "$version" > "$stage/race.log" 2>&1 &
pid=$!
created=no
while kill -0 "$pid" 2>/dev/null; do
  for directory in "$HOME"/.local/lib/mate-node/versions/.install-*; do
    if [ -f "$directory/.mate-install-stage" ] && [ -f "$directory/app/apps/node/dist/main.js" ]; then
      mkdir -p "$HOME/.local/bin"
      if ln "$stage/foreign" "$HOME/.local/bin/mate" 2>/dev/null; then
        created=yes
        break
      fi
    fi
  done
  [ "$created" = no ] || break
done
[ "$created" = yes ] || { cat "$stage/race.log" >&2; echo 'Concurrent-file copy point was not exercised' >&2; exit 1; }
if wait "$pid"; then cat "$stage/race.log" >&2; exit 1; fi
test ! -L "$HOME/.local/bin/mate"
test "$(cat "$HOME/.local/bin/mate")" = 'concurrent unrelated entry'
echo 'PASS actual CLI concurrent initial-entry conflict; the non-Mate file was preserved.'
