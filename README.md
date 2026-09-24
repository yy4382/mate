# Mate

Mate 是面向个人 Slack workspace 的持久 Agent 团队。每个 Agent 有跨频道与 DM 的连续上下文和私有工作空间；模型自行决定关注、协作、工作组织与是否发言。首个可用版本的目标是可部署到低资源 Linux VPS、以独立的非特权 Linux 用户隔离 Agent，并能从 Slack 操作。模型用量持久记录，但不设 token、费用或 run 次数额度。

运行层使用 `@earendil-works/pi-agent-core` 与 `@earendil-works/pi-ai`，依赖与脚本使用 pnpm。普通命令无需逐条审批；系统级命令须由用户在 Slack 中明确批准。

## 从哪里开始

- [产品方向](docs/PROJECT_DIRECTION.md)：目标体验与必须保持的语义。
- [配置说明](docs/CONFIGURATION.md)：内部 Agent 身份、适配器绑定和受管部署配置。
- [本地开发与验证](docs/DEVELOPMENT.md)：安装、测试和可信 JSONL 本地入口。
- [Debian 部署与运维](docs/OPERATIONS.md)：构建、安装、Slack App 接线、启动、升级与恢复。
- [内部会话的 Slack 展示](docs/PROJECTIONS.md)：需要展示内部 DM 时的专门操作。

开发流程使用仓库内的 [Matt skills](.agents/skills/ask-matt/SKILL.md) 和 [GitHub issue tracker](docs/agents/issue-tracker.md)。源码、测试、配置 schema 与生成的 Slack manifest 是当前实现的权威来源；旧路线的细节保存在 Git 历史中，不作为当前任务清单。

## 快速本地启动

按 `package.json` 指定的 Node 和 pnpm 版本安装依赖：

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm typecheck
cp mate.local.example.json mate.local.json
```

把 `mate.local.json` 的 `runtime.dataDir` 改为 checkout 外、当前用户可写的绝对目录，并提供其模型配置引用的环境变量：

```sh
pnpm node dist/src/main.js check mate.local.json
pnpm node dist/src/main.js local mate.local.json
```

`local` 是可信宿主的 JSONL 入口；具体请求和恢复验证见[本地开发说明](docs/DEVELOPMENT.md)。正式受管服务使用[运维步骤](docs/OPERATIONS.md)。普通测试的合成 Slack/provider 结果、目标机 Linux 用户权限与进程检查，以及真实账号连接是不同的验收证据；未完成的发布验收留在 issue tracker 中。
