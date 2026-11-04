#!/bin/bash
# Run by ../test.sh inside debian:13, with deploy/auto-update mounted at /t. Docker, curl and `palace node` are stubs
# that keep the "running" versions in files, so each check reads the image, node version, data and service state.
set -u
install -m 0755 /t/test/stubs/docker /t/test/stubs/curl /usr/local/bin/
useradd -m palace
install -d -o palace /home/palace/.local/bin
install -m 0755 -o palace /t/test/stubs/palace /home/palace/.local/bin/palace
echo 0.1.0 >/home/palace/ver && chown palace /home/palace/ver
touch /home/palace/active && chown palace /home/palace/active

plane=/srv/plane
mkdir -p $plane/data
echo "PALACE_IMAGE=repo/plane:0.1.0" >$plane/.env
echo "original" >$plane/data/schema
echo repo/plane:0.1.0 >/run/plane
cat >/etc/palace-deploy.env <<EOF
PALACE_PLANE_DIR=$plane
PALACE_NODE_USER=palace
PALACE_IMAGE_REPO=repo/plane
PALACE_HEALTH_URL=http://127.0.0.1:1
PALACE_KEEP_BACKUPS=2
PALACE_HEALTH_WAIT=2
PALACE_NODE_CONNECT_WAIT=2
EOF
mkdir -p /var/lib/palace-deploy/bundles
install -m 0755 /t/test/stubs/systemctl /usr/local/bin/
fails=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fails=1; fi; }
bundle() { head -c 1000 /dev/urandom >"/tmp/palace-node-$1-linux-x64.tar.gz"; }
sha() { sha256sum "/tmp/palace-node-$1-linux-x64.tar.gz" | cut -d' ' -f1; }
deploy() { SSH_ORIGINAL_COMMAND="deploy $1 ${2:-$(sha "$1")}" /t/palace-deploy </tmp/palace-node-$1-linux-x64.tar.gz >/tmp/out 2>&1; }
state() { echo "$(sed -n 's/^PALACE_IMAGE=//p' $plane/.env) $(cat /home/palace/ver) $(cat $plane/data/schema) $([ -f /home/palace/active ] && echo active)"; }

bundle 0.1.0
cp /tmp/palace-node-0.1.0-linux-x64.tar.gz /var/lib/palace-deploy/bundles/
echo "$(sha 0.1.0)  palace-node-0.1.0-linux-x64.tar.gz" >/var/lib/palace-deploy/bundles/palace-node-0.1.0-linux-x64.tar.gz.sha256

deploy 0.1.0; check "the running version is a no-op" '[ $? = 0 ] && grep -q "already at 0.1.0" /tmp/out && [ "$(state)" = "repo/plane:0.1.0 0.1.0 original active" ]'

SSH_ORIGINAL_COMMAND="rm -rf /" /t/palace-deploy </dev/null >/tmp/out 2>&1
check "any other command is refused" '[ $? = 2 ] && [ "$(state)" = "repo/plane:0.1.0 0.1.0 original active" ]'

bundle 0.2.0
deploy 0.2.0 0000000000000000000000000000000000000000000000000000000000000000
check "a bundle that does not match its sha256 is refused" '[ $? = 1 ] && [ "$(state)" = "repo/plane:0.1.0 0.1.0 original active" ]'

deploy 0.2.0; code=$?
check "a good version deploys" '[ $code = 0 ] && [ "$(state)" = "repo/plane:0.2.0 0.2.0 migrated by repo/plane:0.2.0 active" ]'
check "the data was backed up first" 'grep -qx original $plane/backups/before-0.2.0-*/schema'

bundle 0.3.0-bad
deploy 0.3.0-bad; code=$?
check "a control plane that never gets healthy rolls back, data included" '[ $code = 1 ] && [ "$(state)" = "repo/plane:0.2.0 0.2.0 migrated by repo/plane:0.2.0 active" ] && grep -q "rolled back" /tmp/out'

bundle 0.4.0-nostart
deploy 0.4.0-nostart; code=$?
check "a node that never connects rolls back the node too" '[ $code = 1 ] && grep -q "(node logs)" /tmp/out && [ "$(state)" = "repo/plane:0.2.0 0.2.0 migrated by repo/plane:0.2.0 active" ] && grep -q "rolled back" /tmp/out'

bundle 0.5.0; deploy 0.5.0; sleep 1; bundle 0.6.0; deploy 0.6.0
check "later versions deploy after a rollback" '[ "$(state)" = "repo/plane:0.6.0 0.6.0 migrated by repo/plane:0.6.0 active" ]'
check "only the newest backups are kept" '[ "$(ls $plane/backups | wc -l)" = 2 ]'
check "only the running and previous bundles are kept" '[ "$(ls /var/lib/palace-deploy/bundles | sort | tr "\n" " ")" = "palace-node-0.5.0-linux-x64.tar.gz palace-node-0.5.0-linux-x64.tar.gz.sha256 palace-node-0.6.0-linux-x64.tar.gz palace-node-0.6.0-linux-x64.tar.gz.sha256 " ]'
check "the log has every deploy" '[ "$(grep -c "deploy " /var/lib/palace-deploy/deploy.log)" -ge 7 ]'
cat >>/etc/palace-deploy.env <<EOF
PALACE_PLANE_SERVICE=palace-control-plane.service
EOF
bundle 0.7.0
touch /run/apns-unavailable-once
before=$(state)
deploy 0.7.0; code=$?
check "a credential fetch failure during startup rolls back through systemd" '[ $code = 1 ] && [ "$(state)" = "$before" ] && grep -q "rolled back" /tmp/out && [ "$(grep -c "start palace-control-plane.service" /run/systemctl-actions)" = 2 ]'
deploy 0.7.0; code=$?
check "systemd deployments use the configured service" '[ $code = 0 ] && [ "$(state)" = "repo/plane:0.7.0 0.7.0 migrated by repo/plane:0.7.0 active" ] && grep -qx "start palace-control-plane.service" /run/systemctl-actions'
bundle 0.8.0-bad
deploy 0.8.0-bad; code=$?
check "systemd deployments restore the previous image and node on failure" '[ $code = 1 ] && grep -q "rolled back" /tmp/out && [ "$(state)" = "repo/plane:0.7.0 0.7.0 migrated by repo/plane:0.7.0 active" ]'
[ $fails = 0 ] || { echo "--- last output"; cat /tmp/out; }
[ $fails = 0 ] || exit "$fails"
bash /t/test/apns.sh
