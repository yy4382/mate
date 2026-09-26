# Debian 13 部署与运维

Mate 首版在一台 Debian 13 VPS 上运行两个服务：`mate-control-plane.service` 用专用非特权账号 `mate-control` 保存共享事实和提供网页；`mate-node.service` 以 root 运行，按控制面批准的请求建立 Agent Linux 用户并切换普通命令的 UID。Caddy 终止 HTTPS，代理到仅监听 `127.0.0.1` 的控制面。Agent、频道、成员和模型凭据在网页管理，不写入部署 JSON。

## 安装

`/etc/mate` 允许 Caddy 穿行读取公开站点配置；所有者密码与节点令牌文件仍仅 root 可读。

目标机需有 systemd、Node.js 24 (`/usr/bin/node`)、Caddy (`/usr/bin/caddy`)、`curl`、`getent`、`useradd`、`setpriv`、`systemd-run`，以及对公网解析的域名与 80/443 端口。在与目标机相同的 Debian 13 架构上运行 `pnpm install --frozen-lockfile && pnpm build`，使原生 Node 模块与目标机匹配；将完整的 `dist`、`node_modules`、`package.json`、`pnpm-lock.yaml` 作为一个发布目录安全传到目标机。不要传源码、开发数据或私有研究资料。`mate.deploy.example.json` 是部署配置模板；修改域名、端口和路径后放到目标机的 root 私有目录。

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
Type=notify
NotifyAccess=all
User=root
Group=root
WorkingDirectory=/opt/mate/current
Environment=MATE_NODE_DATA_DIR=/var/lib/mate-node
Environment=MATE_NODE_AGENT_HOME_ROOT=/var/lib/mate-agents
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

恢复仅按原节点身份恢复到原主机。先运行 `sha256sum -c` 和 `tar -tf` 检查归档，再停止节点及全部 Agent scope；把当前两个数据目录另存到 root-only 目录，避免与旧数据合并；最后以 root 使用 `tar --numeric-owner --same-owner --same-permissions` 解包到 `/var/lib`。启动 `mate-node.service` 后检查服务日志及网页节点状态。节点重连时会向控制面回报待核对的节点收据；无法证明的操作仍保持未知并暂停受影响 Agent。控制面本机的 `reconcile` / `release-agent` 只读取部署配置中的本机节点数据目录，不能代替远程主机的磁盘恢复或清除远程未知结果。不要在新主机上直接恢复旧归档，除非先逐一核对并恢复相同的 Agent 用户名、UID、GID 和 home 身份。

备份失败时命令会尝试恢复维护前的服务状态；如果恢复失败，会再次确认全部服务停止后报告诊断错误。若无法证明服务已恢复或已全部停止，不要启动新版本，先检查两个 Mate 单元及 Agent scope，再运行 `doctor`。

安装器和 `doctor` 的本机结果不等于 Debian 13 原生验收。发布前仍须在可重置的 systemd 主机上核对服务 UID、`mate-control` 无权读 Agent home、两个 Agent 之间跨 UID 拒读、普通命令的 `setpriv` 身份、节点配对、Caddy HTTPS/WSS、升级和协调恢复。macOS 单元测试、模拟宿主入口和隔离容器权限测试须分别记录，不能冒充 VPS 原生通过。

## 网页安装与通知

在 HTTPS 页面用浏览器“安装应用”或手机“添加到主屏幕”。登录后由所有者点击“开启通知”，浏览器才申请权限并登记 Web Push 订阅。控制面只对 Agent 发给所有者的私信、包含 `@owner` 或 `@所有者` 的 Agent 消息和新建系统特权审批请求入队；Agent 间私信不自动推送。审批只在首次创建时入队，点击通知打开原频道中的审批卡。Push 发送失败或浏览器 SSE 断线不会撤销已提交的消息或审批。浏览器、操作系统和推送服务对权限及送达有各自限制；`doctor` 不将第三方送达报告为成功。
