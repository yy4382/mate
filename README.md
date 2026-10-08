# Mate

Mate 是让 Agent 同事持续工作与协作的个人环境。所有者通过 Mate 自己的中文网页交流、管理频道与 Agent、查看运行状态。每个 Agent 跨频道、讨论串和私信共用一条连续上下文，至多运行一条主模型循环，并有自己的默认工作区。运行层使用 `@earendil-works/pi-agent-core` 与 `@earendil-works/pi-ai`。

首个可用版本面向低资源 Linux VPS：运行路径是控制面 Docker 镜像/Compose 与现有普通账号目录内的 node 完整发布包及 systemd 用户服务：薄 shell bootstrap 安装统一 `mate` CLI，后续由 `mate node` 管理安装、启停、状态、日志、同版本整包更新与卸载，详见 [ADR-0009](docs/adr/0009-lightweight-linux-packaging.md)。控制面本地镜像与单服务 Compose 已有[构建和运行入口](docs/CONTROL_PLANE_DEPLOYMENT.md)；node 完整包与 CLI 的安装、服务、停机更新和保留数据卸载入口见[运维说明](docs/OPERATIONS.md)；实际平台证据与未验收项见[部署验收](docs/DEPLOYMENT_ACCEPTANCE.md)。下文源码入口仅用于开发与测试。Mate 不创建用户、不切换身份、不为 Agent 命令建 systemd 单元；Agent 显式使用 `sudo` 时，由宿主的 sudo 配置决定权限。网页支持手机使用、PWA 安装和所有者主动授权的 Web Push。

## 文档

- [产品方向](docs/PROJECT_DIRECTION.md)
- [源码导航与类型约定](docs/SOURCE_GUIDE.md)
- [本地开发](docs/DEVELOPMENT.md)
- [Linux 运行与运维](docs/OPERATIONS.md)
- [控制面镜像与 Compose](docs/CONTROL_PLANE_DEPLOYMENT.md)
- [运行配置](docs/CONFIGURATION.md)
- [架构决定](docs/adr/0003-web-control-plane-and-linux-nodes.md)

## 源码入口

| package                                       | 职责与入口                                                                                                             |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `apps/web`（`@mate/web`）                     | 中文网页、静态资源与页面测试；从 `src/main.tsx` 进入功能页面。                                                         |
| `apps/control-plane`（`@mate/control-plane`） | 对话、任务、Pi 模型循环、会话、运行状态与模型凭据；`src/main.ts` 启动，`src/application.ts` 组装领域能力和 Hono 应用。 |
| `apps/node`（`@mate/node`）                   | 工作区、文件、普通命令、进程控制与本地收据；`src/main.ts` 启动节点，`src/management/cli.ts` 提供发布包管理。           |
| `packages/protocol`（`@mate/protocol`）       | 共用通信契约、操作数据与推导类型；公共入口在 `src/index.ts`。                                                          |

浏览器安全契约通过 `@mate/protocol/owner` 和 `@mate/protocol/workspace` 导出，操作请求摘要通过 `@mate/protocol/node` 导出。控制面通过 `@mate/web/assets` 定位网页构建结果；联调测试使用节点的明确导出。节点构建生成文件辅助进程与原生重命名程序，节点不安装模型库、不接收模型凭据或会话上下文。根目录管理工作区、开发配置、聚合命令和文档，`pnpm build` 按包依赖顺序构建；完整阅读路线见[源码导航](docs/SOURCE_GUIDE.md)。

## 本地检查

按 `package.json` 指定的 Node 24 与 pnpm 版本运行：

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm typecheck
```

`pnpm build` 生成控制面、节点和网页发布内容。本地调试可用 `MATE_CONTROL_PLANE_DATA_DIR`、`MATE_OWNER_PASSWORD_FILE` 配置控制面，运行 `pnpm start:control-plane`，再用 `pnpm dev:web` 从浏览器访问 `http://127.0.0.1:5173`。本地 `localhost` 可验证 PWA 基本流程；公开 Web Push 与 HTTPS 需要真实 HTTPS 环境。源码调试步骤见[本地开发](docs/DEVELOPMENT.md)，生产运行步骤见[运维说明](docs/OPERATIONS.md)。
