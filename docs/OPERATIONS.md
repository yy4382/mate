# Debian 13 部署与运维

Mate 首版在一台 Debian 13 VPS 上运行两个服务：`mate-control-plane.service` 用专用非特权账号 `mate-control` 保存共享事实和提供网页；`mate-node.service` 以 root 运行，按控制面批准的请求建立 Agent Linux 用户并切换普通命令的 UID。Caddy 终止 HTTPS，代理到仅监听 `127.0.0.1` 的控制面。Agent、频道、成员和模型凭据在网页管理，不写入部署 JSON。

## 安装

目标机需有 systemd、Node.js 24 (`/usr/bin/node`)、Caddy (`/usr/bin/caddy`)、`curl`、`getent`、`useradd`、`setpriv`、`systemd-run`，以及对公网解析的域名与 80/443 端口。构建机运行 `pnpm install --frozen-lockfile && pnpm build`，将完整的 `dist`、`node_modules`、`package.json`、`pnpm-lock.yaml` 作为一个发布目录安全传到目标机。不要传源码、开发数据或私有研究资料。`mate.deploy.example.json` 是部署配置模板；修改域名、端口和路径后放到目标机的 root 私有目录。

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

节点成功配对后使用保存的节点身份重连。确认网页显示节点在线后，从 `/etc/mate/node.env` 删除一次性令牌并重启节点验证身份重连，再创建 Agent。升级时安装器会根据保存的节点身份启动节点，不依赖旧令牌。控制面端口只能从本机访问；Caddy 负责外部 HTTPS 和远程节点的 WSS。远程节点操作者在远端安装同版节点、将 `MATE_CONTROL_PLANE_URL` 设为公开 HTTPS 原点并使用网页令牌配对；跨机部署需自行准备节点数据、Agent home、备份和防火墙。

## 状态、日志与升级

`doctor` 读取三个服务的 systemd 状态、本机控制面 `/api/status` 和公开 HTTPS `/api/status`，不输出密码或配对令牌。`ActiveState=active` 只证明进程存在；节点实际在线和 Agent 运行情况在网页查看。诊断日志分别用 `sudo journalctl -u mate-control-plane.service -n 100 --no-pager`、`sudo journalctl -u mate-node.service -n 100 --no-pager` 和 `sudo journalctl -u caddy.service -n 100 --no-pager` 查看，分享日志前检查是否包含敏感数据。

升级控制面与节点必须作为一套版本进行，并在维护期先停两项服务和托管 Agent 进程，取得包含控制面数据库、节点身份与操作收据、Agent home 的协调检查点。`upgrade` 更换同一发布链接并重新启动服务，也会重新加载 Mate 托管的 Caddy 配置；它不创建备份。发布目录须包含同样的四项构建输出：

```sh
sudo /usr/bin/node /opt/mate/current/dist/src/deployment/cli.js upgrade /ABSOLUTE/mate.deploy.json /ABSOLUTE/new-release
sudo /usr/bin/node /opt/mate/current/dist/src/deployment/cli.js doctor /ABSOLUTE/mate.deploy.json
```

安装器和 `doctor` 的本机结果不等于 Debian 13 原生验收。发布前仍须在可重置的 systemd 主机上核对服务 UID、`mate-control` 无权读 Agent home、两个 Agent 之间跨 UID 拒读、普通命令的 `setpriv` 身份、节点配对、Caddy HTTPS/WSS、升级和协调恢复。macOS 单元测试、模拟宿主入口和隔离容器权限测试须分别记录，不能冒充 VPS 原生通过。

## 网页安装与通知

在 HTTPS 页面用浏览器“安装应用”或手机“添加到主屏幕”。登录后由所有者点击“开启通知”，浏览器才申请权限并登记 Web Push 订阅。控制面只对 Agent 发给所有者的私信、包含 `@owner` 或 `@所有者` 的 Agent 消息和新建系统特权审批请求入队；Agent 间私信不自动推送。审批只在首次创建时入队，点击通知打开原频道中的审批卡。Push 发送失败或浏览器 SSE 断线不会撤销已提交的消息或审批。浏览器、操作系统和推送服务对权限及送达有各自限制；`doctor` 不将第三方送达报告为成功。
