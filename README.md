# Mate

Mate 是让 Agent 同事持续工作与协作的个人环境。所有者通过 Mate 自己的中文网页交流、管理频道与 Agent、查看运行状态并审阅系统特权命令。每个 Agent 有跨频道、讨论串和私信的连续上下文，在 Linux 节点上拥有独立的非特权用户和私人目录。运行层使用 `@earendil-works/pi-agent-core` 与 `@earendil-works/pi-ai`。

首个可用版本在 Debian 13 VPS 上以控制面和 Linux 节点两个 systemd 服务运行，Caddy 提供 HTTPS。控制面只监听本机，并用专用非特权账号保存共享事实；节点以 root 运行，以便安全地创建和切换 Agent Linux 用户。网页支持手机使用、PWA 安装和所有者主动授权的 Web Push。

## 文档

- [产品方向](docs/PROJECT_DIRECTION.md)
- [本地开发](docs/DEVELOPMENT.md)
- [Debian 部署与运维](docs/OPERATIONS.md)
- [部署配置](docs/CONFIGURATION.md)
- [架构决定](docs/adr/0003-web-control-plane-and-linux-nodes.md)

## 本地检查

按 `package.json` 指定的 Node 24 与 pnpm 版本运行：

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm typecheck
```

`pnpm build` 生成控制面、节点和网页发布内容。本地调试可用 `MATE_CONTROL_PLANE_DATA_DIR`、`MATE_OWNER_PASSWORD_FILE` 配置控制面，运行 `pnpm start:control-plane`，再用 `pnpm dev:web` 从浏览器访问 `http://127.0.0.1:5173`。本地 `localhost` 可验证 PWA 基本流程；公开 Web Push 与 Caddy TLS 需要真实 HTTPS 环境。部署命令和身份核对见[运维说明](docs/OPERATIONS.md)。
