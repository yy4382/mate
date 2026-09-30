# Mate

Mate 是让 Agent 同事持续工作与协作的个人环境。所有者通过 Mate 自己的中文网页交流、管理频道与 Agent、查看运行状态。每个 Agent 跨频道、讨论串和私信共用一条连续上下文，至多运行一条主模型循环，并有自己的默认工作区。运行层使用 `@earendil-works/pi-agent-core` 与 `@earendil-works/pi-ai`。

首个可用版本面向低资源 Linux VPS：控制面和节点以同一个现有普通账号运行，Mate 不创建用户、不切换身份、不操作 systemd。Agent 命令是普通子进程；Agent 显式使用 `sudo` 时，由宿主的 sudo 配置决定权限。网页支持手机使用、PWA 安装和所有者主动授权的 Web Push。

## 文档

- [产品方向](docs/PROJECT_DIRECTION.md)
- [本地开发](docs/DEVELOPMENT.md)
- [Linux 运行与运维](docs/OPERATIONS.md)
- [运行配置](docs/CONFIGURATION.md)
- [架构决定](docs/adr/0003-web-control-plane-and-linux-nodes.md)

控制面和节点共用的通信校验、会话记录、操作数据与身份计算位于 `packages/protocol`（`@mate/protocol`）；摘要与工具调用身份通过 `@mate/protocol/node` 导出。Linux 节点、模型与命令、文件执行和节点操作账本位于 `apps/node`（`@mate/node`），节点构建会同时生成模型进程、文件操作辅助进程和原生重命名程序。控制面只使用协议 package 的共享定义；控制面与节点联调测试通过节点的明确导出使用节点。根构建会先构建协议 package。

## 本地检查

按 `package.json` 指定的 Node 24 与 pnpm 版本运行：

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm typecheck
```

`pnpm build` 生成控制面、节点和网页发布内容。本地调试可用 `MATE_CONTROL_PLANE_DATA_DIR`、`MATE_OWNER_PASSWORD_FILE` 配置控制面，运行 `pnpm start:control-plane`，再用 `pnpm dev:web` 从浏览器访问 `http://127.0.0.1:5173`。本地 `localhost` 可验证 PWA 基本流程；公开 Web Push 与 HTTPS 需要真实 HTTPS 环境。以普通账号直接启动控制面与节点、停止重启和故障诊断的步骤见[运维说明](docs/OPERATIONS.md)。

