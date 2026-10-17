#!/bin/sh
# Install a built bundle on a clean Debian 13 and Ubuntu 24.04 (no Node on the host), as an ordinary account, and
# drive it through the installed `mate` command: install, configure, status, run the node until it is stopped,
# uninstall. systemctl is a stand-in that only records calls; `systemd-analyze verify` checks the unit file itself.
# Usage: sh deploy/node/smoke-test.sh dist/node-bundles/mate-node-<version>-linux-<arch>.tar.gz
set -eu
bundle=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
case "$bundle" in
  *-linux-x64.tar.gz) platform=linux/amd64 ;;
  *-linux-arm64.tar.gz) platform=linux/arm64 ;;
  *) echo "usage: $0 <mate-node-VERSION-linux-ARCH.tar.gz>" >&2; exit 2 ;;
esac
for image in debian:13 ubuntu:24.04; do
  echo "== $image ($platform)"
  docker run --rm --platform "$platform" \
    --volume "$bundle:/bundles/$(basename "$bundle"):ro" \
    --volume "$bundle.sha256:/bundles/$(basename "$bundle").sha256:ro" \
    "$image" sh -ec '
      apt-get update -qq >/dev/null && apt-get install -y -qq systemd >/dev/null 2>&1
      useradd --create-home owner
      mkdir /fake && printf "#!/bin/sh\necho ActiveState=inactive\n" > /fake/systemctl && chmod 755 /fake/systemctl
      su owner -c "
        set -e
        export PATH=/fake:\$HOME/.local/bin:\$PATH
        cd /tmp && tar -xzf /bundles/*.tar.gz
        ./mate-node/bin/mate node install /bundles/*.tar.gz
        rm -r mate-node
        command -v mate
        mate node configure --control-plane http://127.0.0.1:9 --pairing-token smoke-token
        mate node status
        systemd-analyze verify --man=no \$HOME/.config/systemd/user/mate-node.service
        status=0; timeout --preserve-status --signal=TERM 3 mate node run || status=\$?
        test \$status = 0 || { echo \"node run ended with \$status, expected 0 after SIGTERM\"; exit 1; }
        test -f \$HOME/.local/share/mate/node/node-identity.json
        mate node uninstall
        test ! -e \$HOME/.local/lib/mate-node && test -f \$HOME/.config/mate/node.json
      "
      echo smoke-ok
    '
done
