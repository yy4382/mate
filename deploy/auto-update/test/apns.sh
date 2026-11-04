#!/bin/bash
set -euo pipefail
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
mkdir "$fixture/bin" "$fixture/plane"
printf 'test-service-token' >"$fixture/token"
chmod 600 "$fixture/token"
cat >"$fixture/config" <<EOF
PALACE_PLANE_DIR=$fixture/plane
PALACE_OP_TOKEN_FILE=$fixture/token
PALACE_OP_VAULT=test-vault
PALACE_OP_DOCUMENT=test-document
EOF
export APNS_FIXTURE="$fixture"
cat >"$fixture/bin/op" <<'STUB'
#!/bin/bash
set -eu
[ "$OP_SERVICE_ACCOUNT_TOKEN" = test-service-token ]
[ -z "${OP_CONNECT_TOKEN:-}" ] && [ -z "${OP_CONNECT_HOST:-}" ]
[ "$*" = 'document get test-document --vault test-vault' ]
count=$(cat "$APNS_FIXTURE/fetches" 2>/dev/null || echo 0)
echo $((count + 1)) >"$APNS_FIXTURE/fetches"
if [ -e "$APNS_FIXTURE/unavailable" ]; then echo 'secret-diagnostic-marker' >&2; exit 1; fi
if [ -e "$APNS_FIXTURE/invalid" ]; then echo invalid; else echo "test-key-$((count + 1))"; fi
STUB
cat >"$fixture/bin/openssl" <<'STUB'
#!/bin/bash
set -eu
input=$(cat)
[[ "$input" = test-key-* ]] || exit 1
if [ "$*" = 'pkey -text_pub -noout' ]; then echo 'ASN1 OID: prime256v1'; fi
STUB
cat >"$fixture/bin/swapon" <<'STUB'
#!/bin/bash
if [ -e "$APNS_FIXTURE/swap" ]; then echo /swap; fi
exit 0
STUB
cat >"$fixture/bin/docker" <<'STUB'
#!/bin/bash
set -eu
[ -z "${OP_SERVICE_ACCOUNT_TOKEN:-}" ]
[ -z "${apns_private_key:-}" ]
case "$1 $2" in
  'compose create') echo created >>"$APNS_FIXTURE/actions" ;;
  'compose ps') echo abcdef012345 ;;
  'inspect abcdef012345') echo 'no true false' ;;
  'start --attach') cat >"$APNS_FIXTURE/received" ;;
  'stop --time') echo stopped >>"$APNS_FIXTURE/actions" ;;
  *) exit 1 ;;
esac
STUB
chmod +x "$fixture/bin/"*
export PATH="$fixture/bin:$PATH"
# An inherited exported variable must never turn the new private key into Docker's environment.
export apns_private_key=inherited OP_SERVICE_ACCOUNT_TOKEN=inherited OP_CONNECT_TOKEN=inherited OP_CONNECT_HOST=inherited
/t/palace-apns check "$fixture/config" >"$fixture/output" 2>&1
[ ! -e "$fixture/actions" ]
/t/palace-apns run "$fixture/config" >>"$fixture/output" 2>&1
[ "$(cat "$fixture/received")" = test-key-2 ]
/t/palace-apns run "$fixture/config" >>"$fixture/output" 2>&1
[ "$(cat "$fixture/received")" = test-key-3 ]
[ "$(grep -c stopped "$fixture/actions")" = 2 ]
for failure in unavailable invalid swap; do
  before=$(cat "$fixture/actions")
  touch "$fixture/$failure"
  if /t/palace-apns run "$fixture/config" >>"$fixture/output" 2>&1; then
    echo "FAIL APNs $failure was accepted" >&2
    exit 1
  fi
  [ "$(cat "$fixture/actions")" = "$before" ]
  rm "$fixture/$failure"
done
! grep -Eq 'test-service-token|test-key-|secret-diagnostic-marker' "$fixture/output"
[ -z "$(ls -A "$fixture/plane")" ]
echo 'ok   APNs input is fetched on each start, piped without credential inheritance, and rejected safely on failure'
