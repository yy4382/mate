# 源码导航与类型约定

先从应用入口选择一条具体操作，再沿领域接口读到实现与相邻测试。产品术语见根目录 [CONTEXT.md](../CONTEXT.md)，启动和检查命令见 [DEVELOPMENT.md](DEVELOPMENT.md)，部署步骤见 [OPERATIONS.md](OPERATIONS.md)。

## 从四个 package 的入口开始

| 位置                 | 职责                                     | 阅读入口                                                                                                                                |
| -------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`           | 所有者使用的中文网页                     | `src/main.tsx` 选择页面，再进入 `src/features/` 的相应功能。                                                                            |
| `apps/control-plane` | 所有者登录、持久状态、模型循环与请求路由 | `src/main.ts` 启动服务；`src/application.ts` 的 `createControlPlane` 组装领域能力与 Hono 应用；`src/http.ts` 定义登录、推送和网页路由。 |
| `apps/node`          | 节点连接、工作区、文件与普通命令执行     | `src/main.ts` 启动节点，`src/connection/node-client.ts` 组织连接；发布包管理从 `src/management/cli.ts` 进入。                           |
| `packages/protocol`  | 跨包数据契约及其推导类型                 | `src/index.ts` 列出节点通信公共导出，`src/owner.ts` 与 `src/workspace.ts` 提供浏览器安全契约。                                          |

控制面运行 Pi 模型循环，节点负责宿主操作。`createControlPlane` 返回 `http`、领域能力和 `close`；各领域 `http.ts` 构建自己的链式 Hono 应用，由 `application.ts` 用 `.route()` 组合。

## 沿具体操作阅读

下面的控制面路径相对于 `apps/control-plane/src/`，节点路径相对于 `apps/node/src/`。

| 想理解的操作   | 阅读路线                                                                                                                                                                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 所有者发送消息 | `conversations/http.ts` → `chat.messages.createMessage` → `conversations/messages/writer.ts`；模型工作继续沿 `runtime/runs/coordinator.ts` → `runtime/loop.ts` → `runtime/session/service.ts` 阅读。                                           |
| 模型调用工具   | `runtime/tools/registry.ts` 组合目录与执行入口；对话、任务和提醒工具在 `conversations/`，文件工具在 `workspaces/`，普通命令工具在 `runtime/processes/operations.ts`。                                                                          |
| 读取工作区文件 | `workspaces/http.ts` → `workspace.reads` → `workspaces/reads/service.ts` → `workspaces/access/service.ts` → `nodes.operations`；节点侧从 `connection/workspace-requests.ts` 进入 `files/workspace-executor.ts` 与 `files/file-operation.mts`。 |
| 管理节点发布包 | 节点 `management/cli.ts` 解读参数，`management/service/commands.ts` 执行服务命令；安装、更新和卸载分别进入 `install-entry.ts`、`update.ts` 和 `uninstall.ts`。                                                                                 |

## 控制面按领域找实现

以下目录都位于 `apps/control-plane/src/`。

| 领域                 | 实现与相关定义                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 对话、频道与成员     | `conversations/service.ts` 的 `createOwnerChat` 组装领域能力，并组合 snapshot 与 Agent 工具。`channels/directory.ts` 提供对话目录和私信，`channels/membership.ts` 提供频道管理与成员动作；调用方通过 `chat.conversations`、`chat.channels` 进入。                                                                                                                                               |
| 消息与注意力         | `conversations/messages/writer.ts` 保存消息，`timeline.ts` 读取消息页与讨论串，`attention.ts` 管注意力、草稿和讨论位置，`deliveries.ts` 管消息投递；`events.ts` 保存事件并连接推送。                                                                                                                                                                                                            |
| 任务与提醒           | `conversations/tasks/service.ts` 管任务、责任与活动，`tasks/reminders.ts` 管提醒。工具输入在 `conversations/tools/contracts.ts`，工具结果持久化在 `tools/actions.ts`。                                                                                                                                                                                                                          |
| Agent                | `agents/http.ts` 构建 Agent 与模型供应商路由；`directory.ts` 管身份、资料、创建阶段与目录，`contracts.ts` 定义请求。                                                                                                                                                                                                                                                                            |
| 模型运行与会话       | `runtime/runs/coordinator.ts` 组织运行，`loop.ts` 连接 Pi 响应、上下文转换和会话事件。`runs/records.ts` 保存运行记录，`runs/control.ts` 提供人工运行控制；`session/service.ts` 保存完整会话，`session/compaction.ts` 组织摘要输入，`session/image-context.ts` 投影图片内容。                                                                                                                    |
| 工具与操作记录       | `runtime/tools/registry.ts` 组合并调用工具，`entry.ts` 定义工具入口，`identity.ts` 提供工具调用身份与 action ID 到 operation ID 的算法；`runtime/processes/operations.ts` 连接普通命令与操作记录，`runtime/recovery/context.ts` 组装运行接续输入。                                                                                                                                                                                          |
| 工作区               | `workspaces/service.ts` 组装 `reads`、`actions`、`downloads` 和 Agent 工具。`reads/service.ts` 读取文件，`reads/file-content.ts` 解释文本与字节，`reads/image-result.ts` 表达图片结果；`actions/service.ts` 执行文件变更，`actions/ledger.ts` 保存操作记录；`downloads/service.ts` 管下载。节点适配在 `access/service.ts`，结果与请求契约在 `results.ts`、`contracts.ts`、`tool-contracts.ts`。 |
| 附件                 | `attachments/service.ts` 提供上传、列表、读取、下载和工具组合；`publication.ts` 表达 Agent 文件发布；`access.ts` 处理对话权限，`rows.ts` 投影数据库行，`storage.ts` 管文件流与存储路径，`results.ts` 解析发布结果。                                                                                                                                                                             |
| 节点                 | `nodes/directory.ts` 管连接并组合 `identity` 与 `operations`。`identity.ts` 管配对、签名和账号记录，`operations.ts` 提供工作区准备、文件与进程请求；`pending-requests.ts` 关联等待中的请求，`reconciliation.ts` 读取操作收据，`transport.ts` 定义 socket/session 与消息发送。                                                                                                                   |
| 登录、供应商与通知   | `auth/service.ts` 保存所有者凭据和会话，`session-cookie.ts` 表达 cookie，`login-gate.ts` 组织密码检查。`providers/catalog.ts` 提供模型目录，`credentials.ts` 保存模型凭据，`active-check.ts` 与 `active-check-cli.ts` 提供主动协议检查。`notifications/push.ts` 管网页推送，`mentions-owner.ts` 识别所有者提及。                                                                                |
| 提示词、历史与数据库 | `prompts/index.ts` 列出提示词构建入口，`system.ts`、`runtime.ts`、`summary.ts` 分别构造系统、运行消息和摘要提示，`inspection.ts` 与 `inspect.ts` 提供本地诊断；`agent-history.ts` 提供已确认历史检索。`storage/initialize.ts` 打开控制面数据库，`storage/schema.ts` 装配领域 SQL 表定义。                                                                                                       |

领域中的 `schema.ts`、`*-schema.ts` 是 SQL 表定义，`contracts.ts` 是 Zod 数据契约，`rows.ts` 是数据库查询投影。附件表定义位于 `attachments/schema.ts`。

## 网页按用户功能找实现

功能目录位于 `apps/web/src/features/`。

| 功能             | 页面、数据与展示                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 对话             | `conversations/chat-page.tsx` 组合频道选择、提交和移动视图。`feed/use-conversation-feed.ts` 提供 snapshot、事件流与历史窗口；`use-conversation-thread.ts`、`use-conversation-attachments.ts`、`use-owner-push.ts` 分别提供讨论串、附件和通知动作。`feed/use-message-tasks.ts` 提供消息任务状态与动作，`ui/message-tasks.tsx` 显式展示任务卡与 `TaskCreationForm`。其他 `ui/` 文件对应侧栏、时间线、讨论串、编辑器与频道弹窗。 |
| Agent 与模型凭据 | `agents/agents-page.tsx` 组合创建、目录与工作区。`agent-requests.ts` 的 `readAgentDirectory` 读取目录；`data/use-agent-directory.ts` 与 `use-model-credentials.ts` 提供数据和动作。`ui/` 放创建、编辑、凭据表单和活动组件；`agent-status.ts`、`agent-stop-status.ts` 解释展示文案。                                                                                                                                           |
| 节点             | `nodes/nodes-page.tsx` 提供节点列表与配对令牌，`node-responses.ts` 定义页面响应投影。                                                                                                                                                                                                                                                                                                                                         |
| 任务与提醒       | `tasks/tasks-page.tsx` 与 `reminders/reminders-page.tsx` 展示相应管理界面；响应投影分别在 `task-responses.ts`、`reminder-responses.ts`。                                                                                                                                                                                                                                                                                      |
| 工作区           | `workspace/workspace-browser.tsx` 展示目录与文件预览，`use-workspace-download.ts` 提供下载状态与动作，`download-status.ts` 解释状态文案，`workspace-requests.ts` 与 `workspace-responses.ts` 表达请求和响应。                                                                                                                                                                                                                 |

`apps/web/src/http-json.ts` 共享 JSON 请求、响应读取和错误文案提取；资料读取、对话和工作区分别使用 `readJSON`、`ownerJSON`、`workspaceJSON`。各功能的 `*-responses.ts` 从 protocol 推导页面投影。

页面样式与功能相邻。`src/style.css` 定义全局基础；对话页按 shell → conversation → dialog → mobile → message-details 的顺序导入 `conversations/styles/`，其余功能使用相邻 CSS 文件。PWA 的注册与推送授权入口在 `conversations/feed/use-owner-push.ts`，推送与点击处理在 `public/sw.js`，应用信息与图标在 `public/manifest.webmanifest` 和 `public/icon*`；`assets.mjs` 通过 `@mate/web/assets` 导出网页构建目录。

## 节点按执行职责找实现

以下目录都位于 `apps/node/src/`。

| 职责             | 实现入口                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 连接与请求       | `connection/node-client.ts` 组织认证、心跳和重连，`node-identity.ts` 管节点身份；`process-requests.ts` 与 `workspace-requests.ts` 分派进程、文件及收据请求。                                                                                                                                                                                                                                     |
| Agent 工作区     | `provisioning/agent-workspace.ts` 准备默认工作区和 `MEMORY.md`，`workspace-marker.ts` 管工作区身份标记，`errors.ts` 定义创建错误。                                                                                                                                                                                                                                                               |
| 文件操作         | `files/workspace-executor.ts` 选择工作区、执行操作并保存收据；`same-account-files.ts` 启动辅助进程，`workspace-result.ts` 组织响应。`file-operation.mts` 分派实际文件操作，`fixed-workspace-paths.ts` 管目录描述符和路径，`mutations/` 提供内容变更与原子重命名，`file-failures.ts` 表达错误。原生程序在 `files/rename-noreplace.c`，构建入口在 `apps/node/scripts/build-rename-noreplace.mjs`。 |
| 普通命令         | `processes/operation-runtime.ts` 装配数据库与执行器，`operation-ledger.ts` 保存操作收据，`operation-database.ts` 打开操作数据库；`linux-process-executor.ts` 分派命令、查询和停止，`ordinary-command.ts` 管子进程与输出，`linux-processes.ts` 适配 Linux 进程信息。                                                                                                                              |
| CLI 与发布包管理 | `management/cli.ts` 解读命令，`service/commands.ts` 组织安装、启停、状态和日志，`service/unit.ts` 管单元文本与文件，`service/systemd.ts`、`systemd-property.ts` 适配用户服务工具。`bundle.ts` 定义发布包契约，`acquire-bundle.ts` 获取完整包，`paths.ts` 定义受管路径并读取、规范化路径，`install-entry.ts` 管管理目录与 CLI 入口，`configuration.ts` 读取配置；`update.ts`、`repair-bundle.ts`、`uninstall.ts` 对应更新、修复和卸载。      |

跨包使用节点能力时，从 `apps/node/package.json` 的明确导出进入。发布包管理说明集中在 `docs/node/`，从[完整包说明](node/NODE_BUNDLE.md)进入；日常操作见 [OPERATIONS.md](OPERATIONS.md)。

## 跨包契约与类型来源

| 公共入口                   | 源码与用途                                                                                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@mate/protocol`           | `packages/protocol/src/index.ts` 明确导出消息、操作与错误；`messages.ts` 组合工作区身份、结果、收据和 `NodeRequestSchema` / `NodeControlMessageSchema`。 |
| `@mate/protocol/owner`     | `owner.ts` 定义所有者 HTTP 与事件流资料，例如 `ownerMessageSchema` / `OwnerMessage`、`agentSummarySchema` / `AgentSummary`。                             |
| `@mate/protocol/workspace` | `workspace.ts` 定义文件版本、目录页、文件块和下载状态。                                                                                                  |
| `@mate/protocol/node`      | `node.ts` 使用 Node 加密库计算操作请求摘要。                                                                                                             |

工作区操作在 `workspace-operations.ts` 使用 `workspaceOperationSchema` / `WorkspaceOperation`，进程操作在 `process-operations.ts` 使用 `agentProcessOperationSchema` / `AgentProcessOperation`。网页从 `owner` 和 `workspace` 两个浏览器安全入口导入契约，只需要静态形状时使用 `import type`。

Zod 契约提供运行时和静态类型来源：`z.infer` 或 `z.output` 表示解析后的值，`z.input` 表示含默认值或转换前的输入。模块边界和数据库查询保留需要的类型约束；局部值、普通实现函数和链式 Hono 路由使用推断。相关 schemas 通过组合复用，接口从已有值、函数或推导类型表达。

## 测试、构建与开发脚本

各包测试目录沿领域与功能组织，Vitest 配置发现 `*.test.ts`，网页也发现 `*.test.tsx`；protocol 使用 `tests/contracts.test.mjs` 与 `contracts.types.ts`。控制面的 `tests/scenarios/` 放完整场景，`tests/container/` 放交付容器场景，节点与控制面的 `tests/linux/` 放独立进程脚本。运行方式见 [DEVELOPMENT.md](DEVELOPMENT.md)。

| 需要的辅助能力       | 阅读入口                                                                                                                                                                                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 创建、对话或工具准备 | 控制面 `tests/support/agent/` 的 `createAgentCreationFixture`、`createConversationFixture`、`createAgentToolFixture`、`createProcessToolFixture`；文件名分别为 `creation-fixture.ts`、`conversation-fixture.ts`、`agent-tool-fixture.ts`、`process-tool-fixture.ts`。网页 `tests/support/` 提供带初始值的对话与 Agent fixture。 |
| 脚本模型与工具结果   | 控制面 `tests/support/agent/agent-loop.ts` 提供本地 HTTP/SSE，`scripted-provider.ts` 提供具名模型步骤，`scripted-tool-results.ts` 读取工具结果。                                                                                                                                                                                |
| 场景服务与驱动       | 控制面 `tests/support/environment/scenario-environment.ts` 装配服务，`scenario-configuration.ts` 定义配置，`run-services.ts` 管进程输出；`tests/support/scenario/scenario-driver.ts` 驱动所有者 API，`scenario-evidence.ts` 组织场景及证据。`facts/` 放只读事实投影，`node/` 放连接辅助代码。                                   |
| 完整使用示例         | 控制面 `tests/scenarios/report-workflow.ts` 展示两名 Agent 的报告协作，`report-workflow.test.ts` 装配运行入口；其他场景按环境、驱动、证据和恢复能力分组。                                                                                                                                                                       |
| benchmark 与研究探针 | `apps/control-plane/benchmarks/tool-action.mjs` 准备合成会话并输出查询测量，说明见 [tool-action-lookup.md](research/tool-action-lookup.md)；`docs/research/pi-compaction-prefix-probe.mjs` 观察合成请求序列化，说明见 [pi-compaction-cache.md](research/pi-compaction-cache.md)。                                               |

控制面交付在 `deploy/control-plane/`：`Dockerfile`、`compose.yaml` 和 `compose.initialize.yaml` 定义镜像及运行配置，`entrypoint.mjs` 是容器入口，`build.mjs` 提供构建。节点完整包在 `deploy/node/`：`build-bundle.sh` 构建，`create-metadata.mjs` 写清单，`bootstrap.sh` 安装 CLI，`mate-entry.sh` 是命令入口。

根 `package.json` 汇总构建和检查命令，`pnpm-workspace.yaml` 声明包与 Node 版本，`tsconfig.json` 提供共享严格类型设置，各包配置自己的编译与测试范围。`.prettierrc.json` 与 `.prettierignore` 定义格式范围；网页 `vite.config.ts` 定义构建与开发代理。`.github/workflows/ci.yml` 运行项目 Linux 检查，`node-package-build.yml` 构建 node 完整包并保存私有 artifact。
