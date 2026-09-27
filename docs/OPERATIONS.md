# Debian 13 部署与运维

> **重构中的旧实现说明，不是首版目标部署步骤。** 下文对应当前尚未移除的 root、按 Agent 建账号和 systemd 安装代码。新目标见[产品方向](PROJECT_DIRECTION.md)和[单账号执行决定](adr/0004-single-account-command-execution.md)；完成新安装路径前不要用下文部署目标版本。

当前旧实现会在一台 Debian 13 VPS 上运行两个服务：`mate-control-plane.service` 用专用非特权账号 `mate-control` 保存共享事实和提供网页；`mate-node.service` 以 root 运行，建立 Agent Linux 用户并切换普通命令的 UID。Caddy 终止 HTTPS，代理到仅监听 `127.0.0.1` 的控制面。Agent、频道、成员和模型凭据在网页管理，不写入部署 JSON。

## 安装

`/etc/mate` 允许 Caddy 穿行读取公开站点配置；所有者密码与节点令牌文件仍仅 root 可读。

目标机的运行时依赖是 systemd、Node.js 24 (`/usr/bin/node`)、Caddy (`/usr/bin/caddy`)、`curl`、`getent`、`useradd`、`setpriv`、`systemd-run`，以及对公网解析的域名与 80/443 端口。Mate 服务运行不需要编译器或包管理器。

构建只在制作发布目录时需要。构建机必须与目标机使用相同的 Debian 13 版本和 CPU 架构，并安装 Node.js `24.21.0`、pnpm `10.33.0`（仓库 `package.json` 的 `packageManager` 版本）。Debian 构建机还需 `build-essential` 提供的 C 编译器和 make；原生依赖的构建脚本可能需要 `python3` 与 `pkg-config`。构建机需要访问 pnpm 包仓库。它们不属于 Mate 服务的运行时依赖。清理步骤还用到 Debian `procps` 包提供的 `pgrep`；若目标机没有该命令，先安装 `procps` 再运行清理块。正常流程运行 `pnpm install --frozen-lockfile && pnpm build`，然后只把完整的 `dist`、`node_modules`、`package.json`、`pnpm-lock.yaml` 作为一个发布目录安全传到目标机，不传源码、开发数据或私有研究资料。`mate.deploy.example.json` 是部署配置模板；修改域名、端口和路径后放到目标机的 root 私有目录。

#### 专用目标机上的一次性构建

没有匹配构建机时，可以在专用目标机上构建。以下步骤把一个已审查的干净提交中的 Git 跟踪源文件打包；源码归档不包含秘密，但目标机上的副本仍放在 root 私有目录中。所有者密码、节点令牌、模型凭据、运行数据和本机研究资料都不能进入归档或构建目录。

在本地仓库的同一个 shell 会话依次运行下面两个代码块。把 `REV` 设为已审查的提交，工作区必须干净。只导出 `src`、`apps/web`、`scripts`、`tests` 和构建配置；显式排除私有资料目录、Git 元数据、环境文件和生成的 Web `dist`。先检查清单，再记下 SHA-256：

```sh
set -eu
REV=$(git rev-parse HEAD)
test -z "$(git status --porcelain)" || { echo "工作区必须干净" >&2; exit 1; }
git show -s --format='%H %s' "$REV"
RUN_ID="$(date -u +%y%m%d%H%M%S)-$$"
printf 'RUN_ID=%s\n' "$RUN_ID"
ARCHIVE="${TMPDIR:-/tmp}/mate-build-${RUN_ID}.tar"
LIST="${TMPDIR:-/tmp}/mate-build-${RUN_ID}.list"
git archive --format=tar --output="$ARCHIVE" "$REV" \
  src apps/web scripts tests package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json vitest.config.ts \
  ':(exclude,glob)**/.env*' ':(exclude,glob)**/.git/**' \
  ':(exclude,glob)**/.claude/**' ':(exclude,glob)**/.agents/**' \
  ':(exclude,glob)**/dist/**' \
  ':(exclude,top)docs/reference/**' ':(exclude,top)docs/archive/**'
tar -tf "$ARCHIVE" > "$LIST"
if grep -Eq '(^|/)(\.env[^/]*|\.git|\.claude|\.agents)(/|$)|(^|/)docs/(reference|archive)(/|$)|(^|/)apps/web/dist(/|$)' "$LIST"; then
  echo "归档含禁止路径；不要上传" >&2
  exit 1
fi
sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}
sha256_file "$ARCHIVE"
```

清单只应包含上面选择的 Git 跟踪源文件、合成测试夹具和构建配置。若清单审查失败就停止，不上传。下面的 `HOST` 是目标机上的 SSH 账号；`REMOTE_DROP` 是该账号私有 home 下的临时文件名，`REMOTE_STAGE` 是本次唯一的 root 暂存目录。用本地 SHA-256 校验 root 私有副本后，目标机再检查归档清单：

```sh
HOST=operator@mate.example.com # 替换为本次专用目标机的 SSH 账号和主机名
REMOTE_HOME=$(ssh "$HOST" 'printf %s "$HOME"')
REMOTE_DROP="$REMOTE_HOME/mate-build-${RUN_ID}.tar"
REMOTE_STAGE=/root/mate-build-${RUN_ID}
SHA256=$(sha256_file "$ARCHIVE")
ssh "$HOST" "test ! -e '$REMOTE_DROP' && sudo test ! -e '$REMOTE_STAGE'"
scp "$ARCHIVE" "$HOST:$REMOTE_DROP"
ssh "$HOST" "chmod 0600 '$REMOTE_DROP' && sudo install -d -o root -g root -m 0700 '$REMOTE_STAGE' && sudo install -o root -g root -m 0600 '$REMOTE_DROP' '$REMOTE_STAGE/source.tar' && rm -f -- '$REMOTE_DROP'"
printf '%s  %s\n' "$SHA256" "$REMOTE_STAGE/source.tar" | ssh "$HOST" 'sudo sha256sum -c -'
ssh "$HOST" sudo bash -s -- "$REMOTE_STAGE" <<'REMOTE'
set -euo pipefail
stage=$1
tar -tf "$stage/source.tar" > "$stage/source.list"
if grep -Eq '(^|/)(\.env[^/]*|\.git|\.claude|\.agents)(/|$)|(^|/)docs/(reference|archive)(/|$)|(^|/)apps/web/dist(/|$)' "$stage/source.list"; then
  echo "远端归档含禁止路径；不要解包" >&2
  exit 1
fi
REMOTE
```

在目标机的同一个 root shell 会话依次运行下面两个代码块；先确认归档 SHA 校验成功且清单没有禁止路径。`BUILD_ID` 必须与上面的 `RUN_ID` 相同。示例中的一次性账号、源目录和缓存目录只用于本次构建：

```sh
set -eu
BUILD_ID=260927123456-12345 # 替换为刚打印的 RUN_ID
case "$BUILD_ID" in (''|*[!0-9-]*) echo "BUILD_ID 格式无效" >&2; exit 1 ;; esac
BUILDER="matebuild${BUILD_ID}"
REMOTE_STAGE="/root/mate-build-${BUILD_ID}"
WORK="/var/tmp/mate-build-${BUILD_ID}"
BUILD_HOME="$WORK/home"
SOURCE="$WORK/source"
RELEASE="$REMOTE_STAGE/release"
test "${#BUILDER}" -le 32 || { echo "构建账号超过 Linux 名称长度限制；重新生成 RUN_ID" >&2; exit 1; }
getent passwd "$BUILDER" >/dev/null && { echo "构建账号已存在；换用新的 BUILD_ID" >&2; exit 1; }
test -d "$REMOTE_STAGE" && test -f "$REMOTE_STAGE/source.tar" || { echo "缺少本次 root 暂存归档；停止构建" >&2; exit 1; }
test ! -e "$WORK" && test ! -e "$RELEASE" || { echo "构建路径已存在；换用新的 BUILD_ID" >&2; exit 1; }
useradd --system --user-group --home-dir "$BUILD_HOME" --create-home --shell /usr/sbin/nologin "$BUILDER"
install -d -o "$BUILDER" -g "$BUILDER" -m 0700 "$SOURCE" "$BUILD_HOME/.cache" "$BUILD_HOME/.local/share/pnpm"
tar -xf "$REMOTE_STAGE/source.tar" -C "$SOURCE"
chown -R "$BUILDER:$BUILDER" "$WORK"
runuser -u "$BUILDER" -- env -i \
  HOME="$BUILD_HOME" USER="$BUILDER" LOGNAME="$BUILDER" \
  PATH=/usr/local/bin:/usr/bin:/bin \
  COREPACK_ENV_FILE=/dev/null COREPACK_HOME="$BUILD_HOME/.cache/corepack" \
  PNPM_HOME="$BUILD_HOME/.local/share/pnpm" \
  XDG_CACHE_HOME="$BUILD_HOME/.cache" npm_config_cache="$BUILD_HOME/.cache/npm" \
  /bin/bash -eu -c 'cd "$1"; test "$(node --version)" = v24.21.0; test "$(pnpm --version)" = 10.33.0; pnpm install --frozen-lockfile; pnpm build' _ "$SOURCE"
install -d -o root -g root -m 0755 "$RELEASE"
cp -a "$SOURCE/dist" "$SOURCE/node_modules" "$SOURCE/package.json" "$SOURCE/pnpm-lock.yaml" "$RELEASE/"
chown -R root:root "$RELEASE"
# 仅当这个 workspace 链接是悬空链接时删除；其它依赖链接必须保留。
WEB_LINK="$RELEASE/node_modules/.pnpm/node_modules/@mate/web"
if [ -L "$WEB_LINK" ] && [ ! -e "$WEB_LINK" ]; then rm -- "$WEB_LINK"; fi
test "$(find "$RELEASE" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')" = 4
test -z "$(find "$RELEASE" -mindepth 1 -maxdepth 1 ! -name dist ! -name node_modules ! -name package.json ! -name pnpm-lock.yaml -print -quit)"
test -z "$(find -L "$RELEASE" -type l -print -quit)"
find "$RELEASE" -type l -exec sh -eu -c 'root=$(realpath -e "$1"); shift; for link do target=$(realpath -e "$link"); case "$target" in "$root"/*) ;; *) echo "发布链接指向目录之外" >&2; exit 1 ;; esac; done' sh "$RELEASE" {} +
node --check "$RELEASE/dist/src/deployment/cli.js"
node --check "$RELEASE/dist/src/control-plane/main.js"
node --check "$RELEASE/dist/src/node/main.js"
```

检查通过后，确认构建账号没有残留进程，再移除一次性账号、源码和缓存；发布目录留在 root 暂存区，作为安装器输入。Corepack、pnpm、npm 与 node-gyp 缓存都在 `$WORK` 内，不使用或清理系统级缓存。若安装尚未开始，下面的清理块会删掉本次账号、工作区和源码归档/清单，但保留 `$RELEASE`；先核对 `BUILD_ID` 是本次生成值。若 `userdel` 后同名私有组仍存在，只在确认没有账号以该组为主组且组成员列表为空时运行 `groupdel "$BUILDER"`：

```sh
case "$BUILD_ID" in (''|*[!0-9-]*) echo "BUILD_ID 格式无效" >&2; exit 1 ;; esac
test "$REMOTE_STAGE" = "/root/mate-build-${BUILD_ID}"
test "$WORK" = "/var/tmp/mate-build-${BUILD_ID}"
command -v pgrep >/dev/null 2>&1 || { echo "缺少 pgrep；停止清理并安装 procps" >&2; exit 1; }
getent passwd >/dev/null || { echo "无法读取本机账号数据库；停止清理" >&2; exit 1; }
if getent passwd "$BUILDER" >/dev/null; then
  command -v pgrep >/dev/null 2>&1 || { echo "缺少 pgrep；停止清理并安装 procps" >&2; exit 1; }
  if pgrep -u "$BUILDER" >/dev/null; then
    echo "构建账号仍有进程；先核对并停止本次构建，再清理" >&2
    exit 1
  else
    pgrep_status=$?
    test "$pgrep_status" -eq 1 || { echo "无法确认构建账号进程状态；停止清理" >&2; exit 1; }
  fi
  userdel --remove "$BUILDER"
fi
rm -rf -- "$WORK"
rm -f -- "$REMOTE_STAGE/source.tar" "$REMOTE_STAGE/source.list"
if getent group "$BUILDER" >/dev/null; then
  echo "检查同名私有组的成员与主组；确认无人使用后再运行 groupdel $BUILDER" >&2
fi
```

安装成功且 `doctor` 验收完成后，删除 `$RELEASE` 和 `$REMOTE_STAGE`，并在本地删除 `$ARCHIVE` 与 `$LIST`。若构建失败且安装器尚未开始，先用本节清理块移除账号、工作区和归档/清单；核对 `REMOTE_STAGE` 仅含本次临时文件后，再执行 `rm -rf -- "$REMOTE_STAGE"`。若安装器已经开始运行，不要按构建失败步骤递归删除 `/opt/mate`；先检查 systemd 单元、发布目录和 `doctor` 结果。始终核对传入安装器的发布目录顶层恰好只有 `dist`、`node_modules`、`package.json`、`pnpm-lock.yaml`。不要把发布 `node_modules` 当缓存清理。

在目标机建立初始所有者密码文件，至少 12 字节，只有 root 可读。安装器用 systemd `LoadCredential` 将文件提供给非特权控制面；控制面首次启动后保存 Argon2id 哈希，运行时不需要长期保留明文，但恢复空数据库时还需此文件。

```sh
sudo install -d -m 0700 /etc/mate
sudo sh -c 'umask 077; cat > /etc/mate/owner-password'
sudo chmod 0600 /etc/mate/owner-password
sudo /usr/bin/node /ABSOLUTE/release/dist/src/deployment/cli.js install /ABSOLUTE/mate.deploy.json /ABSOLUTE/release
sudo /usr/bin/node /opt/mate/current/dist/src/deployment/cli.js doctor /ABSOLUTE/mate.deploy.json
```

安装器检查旧单服务单元不存在，建立 `mate-control`、私人数据目录、两个 systemd 单元和密封发布目录，启动控制面。`/etc/mate/Caddyfile` 包含 HTTPS 站点和 WebSocket 代理。若 `/etc/caddy/Caddyfile` 尚不存在或已由 Mate 管理，安装器直接启用 Caddy；若它属于其他站点，安装器不覆盖它，输出需要导入 `/etc/mate/Caddyfile` 的提示。完成导入后运行 `sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy`。`doctor` 中 `tls: running` 才代表公开 HTTPS 路径连到本机控制面。

登录 `https://域名/app`，在“节点管理”生成一次性配对令牌。把令牌只写到 `/etc/mate/node.env`，保持 `root:root 0600`，然后启动节点：

```sh
sudo sh -c 'umask 077; cat > /etc/mate/node.env'
# 文件内容为 MATE_NODE_PAIRING_TOKEN=网页生成的令牌
sudo chmod 0600 /etc/mate/node.env
sudo systemctl enable --now mate-node.service
sudo /usr/bin/node /opt/mate/current/dist/src/deployment/cli.js doctor /ABSOLUTE/mate.deploy.json
```

节点成功配对后使用保存的节点身份重连。确认网页显示节点在线后，从 `/etc/mate/node.env` 删除一次性令牌并重启节点验证身份重连，再创建 Agent。升级时安装器会根据保存的节点身份启动节点，不依赖旧令牌。控制面端口只能从本机访问；Caddy 负责外部 HTTPS 和远程节点的 WSS。

### 远程 Linux 节点（手动安装）

控制面安装器只管理控制面主机上的两个服务。远程 Debian 13 主机需手动安装与控制面完全相同的 Mate 发布目录（`dist`、`node_modules`、`package.json`、`pnpm-lock.yaml`），发布包必须在相同 Debian 版本和 CPU 架构上构建。远程主机需要 Node.js 24、systemd、`useradd`、`getent`、`setpriv` 和 `systemd-run`；节点主机只需允许向控制面域名的 TCP 443 出站连接，不需要公网入站端口。Caddy 在控制面主机终止 HTTPS/WSS。

在远程主机将同版本发布目录内容复制到独立的 root 管理发布目录，并建立 `current` 链接。下面的 `remote-v1` 是示例发布标识；首次安装时目标路径必须不存在：

```sh
sudo install -d -o root -g root -m 0755 /opt/mate/releases/remote-v1
sudo cp -a /ABSOLUTE/release/. /opt/mate/releases/remote-v1/
sudo chmod -R go-w /opt/mate/releases/remote-v1
sudo ln -s /opt/mate/releases/remote-v1 /opt/mate/current
```

再准备 root 管理的节点数据目录、Agent home 根目录和私有环境文件：

```sh
sudo install -d -o root -g root -m 0700 /etc/mate /var/lib/mate-node
sudo install -d -o root -g root -m 0755 /var/lib/mate-agents
sudo install -m 0600 /dev/null /etc/mate/node.env
sudoedit /etc/mate/node.env
```

首次配对时，环境文件包含控制面公开 HTTPS 原点和网页生成的一次性令牌：

```text
MATE_CONTROL_PLANE_URL=https://mate.example.com
MATE_NODE_PAIRING_TOKEN=一次性网页令牌
```

以 root 写入 `/etc/systemd/system/mate-node.service`。远程单元不依赖本机控制面服务：

```ini
[Unit]
Description=Mate remote Linux node
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
Group=root
WorkingDirectory=/opt/mate/current
Environment=MATE_NODE_DATA_DIR=/var/lib/mate-node
Environment=MATE_NODE_AGENT_WORKSPACE_ROOT=/var/lib/mate-agents
EnvironmentFile=/etc/mate/node.env
ExecStart=/usr/bin/node /opt/mate/current/dist/src/node/main.js
Restart=on-failure
RestartSec=5
UMask=0077
MemoryMax=768M

[Install]
WantedBy=multi-user.target
```

```sh
sudo chmod 0644 /etc/systemd/system/mate-node.service
sudo systemctl daemon-reload
sudo systemctl enable --now mate-node.service
```

在控制面网页的“节点管理”生成配对令牌后，将令牌写入远程主机，再查看网页节点状态与 `sudo journalctl -u mate-node.service -n 100 --no-pager`。节点在线后从环境文件删除 `MATE_NODE_PAIRING_TOKEN`，保留 `MATE_CONTROL_PLANE_URL`，重启服务并确认节点用 `/var/lib/mate-node/node-identity.json` 中保存的身份重新上线。不要删除或重新生成节点身份文件来修复断线；配对密钥不匹配时保持受影响 Agent 暂停并检查原节点数据与备份。

#### 远程节点掉线排查

先在远程主机运行 `sudo systemctl status mate-node.service --no-pager` 与 `sudo journalctl -u mate-node.service -n 100 --no-pager`，确认服务没有因配置、权限或数据库错误反复重启。再用 `getent ahosts mate.example.com` 检查 DNS，用 `curl -fsS https://mate.example.com/api/status` 检查远端到控制面 HTTPS 的网络路径；这项 HTTP 检查不代替 WSS 配对，最终以节点日志和控制面网页的在线状态为准。检查远端防火墙允许出站 TCP 443，并在控制面主机查看 `sudo journalctl -u caddy.service -n 100 --no-pager` 和 `sudo journalctl -u mate-control-plane.service -n 100 --no-pager`。不要把含一次性令牌的环境文件或完整敏感日志贴入工单。

## 状态、日志与升级

`doctor` 读取三个服务的 systemd 状态、本机控制面 `/api/status` 和公开 HTTPS `/api/status`，不输出密码或配对令牌。`ActiveState=active` 只证明进程存在；节点实际在线和 Agent 运行情况在网页查看。诊断日志分别用 `sudo journalctl -u mate-control-plane.service -n 100 --no-pager`、`sudo journalctl -u mate-node.service -n 100 --no-pager` 和 `sudo journalctl -u caddy.service -n 100 --no-pager` 查看，分享日志前检查是否包含敏感数据。

升级控制面与节点必须作为一套版本进行。`upgrade` 先停两个服务和托管 Agent 进程，再创建包含控制面数据库、节点身份与操作收据、Agent home 的协调检查点；只有检查点完成后才切换发布。检查点失败时不会安装新版本。成功输出包含检查点路径，可供恢复使用。若现有 Caddyfile 导入 `/etc/mate/Caddyfile`，安装器还会校验并重新加载该站点。发布目录须包含同样的四项构建输出：

```sh
sudo /usr/bin/node /opt/mate/current/dist/src/deployment/cli.js upgrade /ABSOLUTE/mate.deploy.json /ABSOLUTE/new-release
sudo /usr/bin/node /opt/mate/current/dist/src/deployment/cli.js doctor /ABSOLUTE/mate.deploy.json
```

维护命令同样使用 root 运行。`backup` 默认把检查点放在 `/var/backups/mate/`；`verify` 检查清单、SQLite 数据库和节点身份；`restore` 在恢复数据后重新核对 Agent 身份及操作收据，再恢复服务；未能证明的 Agent 会保持暂停。`reconcile` 可在人工修复后重新核对当前数据。`release-agent` 会重新执行同一核对，只在 Agent 身份与相关操作结果均可证明时释放它，不会跳过未知结果。

```sh
sudo /usr/bin/node /opt/mate/current/dist/src/deployment/cli.js backup /ABSOLUTE/mate.deploy.json
sudo /usr/bin/node /opt/mate/current/dist/src/deployment/cli.js verify /ABSOLUTE/mate.deploy.json /var/backups/mate/CHECKPOINT
sudo /usr/bin/node /opt/mate/current/dist/src/deployment/cli.js restore /ABSOLUTE/mate.deploy.json /var/backups/mate/CHECKPOINT
sudo /usr/bin/node /opt/mate/current/dist/src/deployment/cli.js reconcile /ABSOLUTE/mate.deploy.json
sudo /usr/bin/node /opt/mate/current/dist/src/deployment/cli.js release-agent /ABSOLUTE/mate.deploy.json AGENT_UUID
```

### 远程节点主机内备份与恢复

控制面主机上的 `backup CONFIG` 只创建该配置所列本机目录的协调检查点；它不会经 WSS 复制远程磁盘，也不能创建跨主机同一时刻的检查点。远程节点的 `nodeDataDir`、配对私钥、节点操作收据和 Agent home 必须在远程主机分别备份。不同主机的备份时间不同，首版不承诺跨机原子恢复。

远程主机备份前先停止节点服务，再枚举并停止该节点所有运行中的 `mate-agent-*.scope`。复制前确认列表为空；不要尝试停止不存在的 `mate-agent.slice`：

```sh
sudo bash -euo pipefail -c '
  systemctl stop mate-node.service
  systemctl list-units --all --type=scope --plain --no-legend "mate-agent-*.scope" | while read -r unit rest; do
    [ -z "$unit" ] || systemctl stop "$unit"
  done
  if systemctl list-units --state=active --type=scope --plain --no-legend "mate-agent-*.scope" | grep -q .; then
    echo "Agent scopes are still active; no backup was made" >&2
    exit 1
  fi
  install -d -o root -g root -m 0700 /var/backups/mate-node
  checkpoint="/var/backups/mate-node/node-host-$(date -u +%Y%m%dT%H%M%SZ).tar"
  tar --numeric-owner --xattrs --acls -cpf "$checkpoint" -C /var/lib mate-node mate-agents
  sha256sum "$checkpoint" > "$checkpoint.sha256"
  chmod 0600 "$checkpoint" "$checkpoint.sha256"
  systemctl start mate-node.service
'
```

归档含节点私钥、执行收据和 Agent 私人文件，备份目录及副本都必须保密；传出主机前先加密。该脚本使用 `set -e`；停止、scope 检查、归档或校验和任一步骤失败时不会运行最后的服务启动命令。保持服务停止，检查没有 Agent scope 运行且原数据仍完整后，再由操作者启动节点；不要把部分归档当成有效备份。

恢复仅按原节点身份恢复到原主机。先运行 `sha256sum -c` 和 `tar -tf` 检查归档，再停止节点及全部 Agent scope；把当前两个数据目录另存到 root-only 目录，避免与旧数据合并；最后以 root 使用 `tar --numeric-owner --same-owner --same-permissions` 解包到 `/var/lib`。

远程节点重连的自动对账范围有限：控制面只会向节点查询控制面已知且状态为 `executing` 或 `unknown` 的 `process` / `workspace` 操作 ID；它不会枚举节点收据来发现只存在于较新节点检查点中的额外操作。因此，不同时间点的控制面与远程节点备份恢复后，不能把重连视为两侧完整一致的证明。

第 25 版起 Mate 没有特权命令审批：升级会连同 `owner_privileged_approvals` 一起删除其中的未完成请求，节点上的 `privileged-operations.sqlite` 也不再被读取或对账，两者都不会变成新的持有、收据或重试。升级前若存在未完成的特权命令且需要这些历史证据，请在首次启动第 25 版前用只读 SQLite 自行留存；升级后不要把旧的审批行或节点收据当成仍受支持的状态。

节点服务保持停止时，先在控制面网页的 Agent 页面停用受影响的 Agent；无法确定额外收据属于哪个 Agent 时，先停用该节点上的全部 Agent。随后在两侧用只读 SQLite 查看节点身份，以及每项操作的 operation ID、Agent ID、请求身份哈希、状态和收据版本：节点侧查看 `agent_process_operations` 和 `workspace-receipts/*.json`；控制面侧查看 `owner_agent_process_operations` 和 `owner_agent_tool_actions`。逐项核对节点公钥、Agent 的用户名/UID/GID/home 标记以及操作身份。发现节点多出操作、任一身份不匹配或结果无法证明时，保持对应 Agent 停用，不要在网页点击“复启 Agent”，也不要运行控制面主机的 `release-agent`；后者只核验部署配置中的本机 `nodeDataDir`，不检查远程磁盘。身份冲突无法定位到单个 Agent，或无法确认节点上所有后台进程已停止时，继续保持该节点服务停止。

停机并确认没有 Agent scope 活动后，再检查远程节点日志和收据目录：

```sh
sudo bash -euo pipefail -c '
  systemctl stop mate-node.service
  systemctl list-units --all --type=scope --plain --no-legend "mate-agent-*.scope" | while read -r unit rest; do
    [ -z "$unit" ] || systemctl stop "$unit"
  done
  if systemctl list-units --state=active --type=scope --plain --no-legend "mate-agent-*.scope" | grep -q .; then
    echo "Agent scopes are still active; keep the node stopped" >&2
    exit 1
  fi
  systemctl status mate-node.service --no-pager || true
  journalctl -u mate-node.service -n 100 --no-pager
  find /var/lib/mate-node/workspace-receipts -maxdepth 1 -type f -name "*.json" -print
'
```

只有在人工核对确认节点身份和该 Agent 的全部操作收据后，才启动 `mate-node.service`；确认网页显示节点在线、Agent 进程停止结果已确认后，才可在网页复启该 Agent。若仍有未知或多出的操作，维持停用并保留诊断信息，不得自动放行。不要在新主机上直接恢复旧归档，除非先逐一核对并恢复相同的 Agent 用户名、UID、GID 和 home 身份。

备份失败时命令会尝试恢复维护前的服务状态；如果恢复失败，会再次确认全部服务停止后报告诊断错误。若无法证明服务已恢复或已全部停止，不要启动新版本，先检查两个 Mate 单元及 Agent scope，再运行 `doctor`。

安装器和 `doctor` 的本机结果不等于 Debian 13 原生验收。发布前仍须在可重置的 systemd 主机上核对服务 UID、`mate-control` 无权读 Agent home、两个 Agent 之间跨 UID 拒读、普通命令的 `setpriv` 身份、节点配对、Caddy HTTPS/WSS、升级和协调恢复。macOS 单元测试、模拟宿主入口和隔离容器权限测试须分别记录，不能冒充 VPS 原生通过。

## 网页安装与通知

在 HTTPS 页面用浏览器“安装应用”或手机“添加到主屏幕”。登录后由所有者点击“开启通知”，浏览器才申请权限并登记 Web Push 订阅。控制面只对 Agent 发给所有者的私信和包含 `@owner` 或 `@所有者` 的 Agent 消息入队；Agent 间私信不自动推送。每种事件只在首次创建时入队，点击通知打开原频道中的消息。Push 发送失败或浏览器 SSE 断线不会撤销已提交的消息。浏览器、操作系统和推送服务对权限及送达有各自限制；`doctor` 不将第三方送达报告为成功。
