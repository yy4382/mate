# Mate

Mate 是让 Agent 同事持续工作与协作的个人环境。所有者通过 Mate 自己的中文网页交流、管理频道与 Agent、查看运行状态。每个 Agent 跨频道、讨论串和私信共用一条连续上下文，至多运行一条主模型循环，并有自己的默认工作区。运行层使用 `@earendil-works/pi-agent-core` 与 `@earendil-works/pi-ai`。

首个可用版本面向低资源 Linux VPS：目标是控制面 Docker 镜像/Compose 与现有普通账号目录内的 node 发布包及 systemd 用户服务，详见 [ADR-0009](docs/adr/0009-lightweight-linux-packaging.md)。该包装尚未实现，当前源码入口与验证步骤见下文。Mate 不创建用户、不切换身份、不为 Agent 命令建 systemd 单元；Agent 显式使用 `sudo` 时，由宿主的 sudo 配置决定权限。网页支持手机使用、PWA 安装和所有者主动授权的 Web Push。

## 文档

- [产品方向](docs/PROJECT_DIRECTION.md)
- [源码导航与类型约定](docs/SOURCE_GUIDE.md)
- [本地开发](docs/DEVELOPMENT.md)
- [Linux 运行与运维](docs/OPERATIONS.md)
- [运行配置](docs/CONFIGURATION.md)
- [架构决定](docs/adr/0003-web-control-plane-and-linux-nodes.md)

控制面和节点共用的通信校验、操作数据与身份计算位于 `packages/protocol`（`@mate/protocol`）；操作请求摘要通过 `@mate/protocol/node` 导出；浏览器安全的数据契约分别通过 `@mate/protocol/owner` 和 `@mate/protocol/workspace` 导出。控制面 `apps/control-plane`（`@mate/control-plane`）在自身进程内异步推进 Pi 模型与工具循环，保存完整会话、压缩记录、运行状态和模型凭据，直接执行对话与任务工具。Linux 节点 `apps/node`（`@mate/node`）只负责工作区、普通命令、文件操作、进程控制和本地收据；节点构建生成文件操作辅助进程和原生重命名程序。节点不安装模型库、不接收模型凭据或会话上下文。网页源码、静态资源与网页测试位于 `apps/web`（`@mate/web`）。控制面通过 `@mate/web/assets` 定位网页构建结果；联调测试通过节点的明确导出使用真实节点。根管理工作区、开发配置、聚合命令和文档，`pnpm build` 按 package 依赖顺序构建。

## 本地检查

按 `package.json` 指定的 Node 24 与 pnpm 版本运行：

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm typecheck
```

`pnpm build` 生成控制面、节点和网页发布内容。本地调试可用 `MATE_CONTROL_PLANE_DATA_DIR`、`MATE_OWNER_PASSWORD_FILE` 配置控制面，运行 `pnpm start:control-plane`，再用 `pnpm dev:web` 从浏览器访问 `http://127.0.0.1:5173`。本地 `localhost` 可验证 PWA 基本流程；公开 Web Push 与 HTTPS 需要真实 HTTPS 环境。以普通账号直接启动控制面与节点、停止重启和故障诊断的步骤见[运维说明](docs/OPERATIONS.md)。
