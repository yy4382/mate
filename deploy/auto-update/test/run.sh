#!/bin/bash
# Run by ../test.sh inside debian:13, with deploy/auto-update mounted at /t. Docker, curl and `mate node` are stubs
# that keep the "running" versions in files, so each check reads the image, node version, data and service state.
set -u
install -m 0755 /t/test/stubs/docker /t/test/stubs/curl /usr/local/bin/
useradd -m mate
install -d -o mate /home/mate/.local/bin
install -m 0755 -o mate /t/test/stubs/mate /home/mate/.local/bin/mate
echo 0.1.0 >/home/mate/ver && chown mate /home/mate/ver
touch /home/mate/active && chown mate /home/mate/active

plane=/srv/plane
mkdir -p $plane/data
echo "MATE_IMAGE=repo/plane:0.1.0" >$plane/.env
echo "original" >$plane/data/schema
echo repo/plane:0.1.0 >/run/plane
cat >/etc/mate-deploy.env <<EOF
MATE_PLANE_DIR=$plane
MATE_NODE_USER=mate
MATE_IMAGE_REPO=repo/plane
MATE_HEALTH_URL=http://127.0.0.1:1
MATE_KEEP_BACKUPS=2
MATE_HEALTH_WAIT=2
MATE_NODE_CONNECT_WAIT=2
EOF
mkdir -p /var/lib/mate-deploy/bundles
fails=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fails=1; fi; }
bundle() { head -c 1000 /dev/urandom >"/tmp/mate-node-$1-linux-x64.tar.gz"; }
sha() { sha256sum "/tmp/mate-node-$1-linux-x64.tar.gz" | cut -d' ' -f1; }
deploy() { SSH_ORIGINAL_COMMAND="deploy $1 ${2:-$(sha "$1")}" /t/mate-deploy </tmp/mate-node-$1-linux-x64.tar.gz >/tmp/out 2>&1; }
state() { echo "$(sed -n 's/^MATE_IMAGE=//p' $plane/.env) $(cat /home/mate/ver) $(cat $plane/data/schema) $([ -f /home/mate/active ] && echo active)"; }

bundle 0.1.0
cp /tmp/mate-node-0.1.0-linux-x64.tar.gz /var/lib/mate-deploy/bundles/
echo "$(sha 0.1.0)  mate-node-0.1.0-linux-x64.tar.gz" >/var/lib/mate-deploy/bundles/mate-node-0.1.0-linux-x64.tar.gz.sha256

deploy 0.1.0; check "the running version is a no-op" '[ $? = 0 ] && grep -q "already at 0.1.0" /tmp/out && [ "$(state)" = "repo/plane:0.1.0 0.1.0 original active" ]'

SSH_ORIGINAL_COMMAND="rm -rf /" /t/mate-deploy </dev/null >/tmp/out 2>&1
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
check "only the running and previous bundles are kept" '[ "$(ls /var/lib/mate-deploy/bundles | sort | tr "\n" " ")" = "mate-node-0.5.0-linux-x64.tar.gz mate-node-0.5.0-linux-x64.tar.gz.sha256 mate-node-0.6.0-linux-x64.tar.gz mate-node-0.6.0-linux-x64.tar.gz.sha256 " ]'
check "the log has every deploy" '[ "$(grep -c "deploy " /var/lib/mate-deploy/deploy.log)" -ge 7 ]'
[ $fails = 0 ] || { echo "--- last output"; cat /tmp/out; }
exit $fails
