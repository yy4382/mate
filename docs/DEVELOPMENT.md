# 本地开发与验证

使用 Node 24 和 pnpm 10.33.0。运行 `pnpm install --frozen-lockfile`、`pnpm check`、`pnpm typecheck`。`pnpm build` 将控制面编译到 `apps/control-plane/dist`、节点编译到 `apps/node/dist`，将网页写入 `apps/web/dist`。节点可单独用 `pnpm build:node` 构建，并通过 `pnpm --filter @mate/node test` 运行本地行为测试。运行环境变量见[配置说明](CONFIGURATION.md)，Linux 上以普通账号直接启动、停止重启与诊断见[运维说明](OPERATIONS.md)。

控制面本地启动需要一个只有当前用户可读的初始密码文件（12–1024 UTF-8 字节）和一个绝对数据目录：

```sh
export MATE_CONTROL_PLANE_DATA_DIR=/ABSOLUTE/private/control-plane
export MATE_OWNER_PASSWORD_FILE=/ABSOLUTE/private/owner-password
pnpm start:control-plane
pnpm dev:web
```

浏览器打开 `http://127.0.0.1:5173`，Vite 将 `/api` 转给本机控制面。PWA 注册和授权入口可在安全的 localhost 上检查；真实公网 Push 送达、域名证书和 Caddy WSS 须在 HTTPS 部署上验证。Web Push 的仓库测试只注入本地伪发送器，验证通知选择、去重、失败不回滚和落点；它不向第三方服务发送通知。

节点启动与配对已按新目标运行：`pnpm start:control-plane` 与 `pnpm start:node` 可在普通账号下直接启动，不需要 root、用户创建或 service manager。节点需要 `MATE_CONTROL_PLANE_URL`；`MATE_NODE_DATA_DIR` 默认为当前目录下的 `data/node`，Agent 工作区根目录默认为节点数据目录下的 `agents`，可用 `MATE_NODE_AGENT_WORKSPACE_ROOT` 覆盖。创建 Agent 也走同一条普通账号路径：节点在运行账号可写的工作区根目录下建立该 Agent 的目录、记忆入口 `MEMORY.md` 和原身份标记，不创建 Linux 账号、不切换 UID/GID。工作区根路径不可写或目标目录已被其他内容占用时，网页按同一请求显示可诊断的失败原因。

```sh
export MATE_CONTROL_PLANE_URL=http://127.0.0.1:8787
export MATE_NODE_DATA_DIR=/ABSOLUTE/private/node
pnpm start:node
```

单账号启动检查以现有普通账号启动控制面与节点，通过真实 WebSocket 配对、创建两名 Agent，分别重启节点和控制面并核对重新认证、在线状态与错误身份拒绝。控制面真实 Pi 循环请求本地脚本化 HTTP/SSE 模型服务，调用节点普通命令并持久保存 transcript；命令实测 UID/GID 和工作目录。脚本核对两名 Agent 独立工作区与 session、`MEMORY.md`、目录权限 `700`，以及没有按 Agent 创建账号。macOS 与 Linux 均可运行，并记录 `kernel`、`hostEnvironment` 与 `linuxKernel`；macOS 结果仅是跨平台证据。工作区不可写的网页失败由 `agent-creation-process.test.ts` 单独覆盖：
```sh
pnpm build
pnpm test:linux-single-account-node
```

工作区与记忆入口接缝另有一个跨平台检查：它不创建 Linux 账号、不要求 root，在同一运行账号下建立两名 Agent 的工作区，核对目录权限、`MEMORY.md`、原身份标记与重试复用，并确认已有内容的目录会被报告而不是被接管：

```sh
pnpm build
pnpm test:single-account-agent-workspace
```

从网页创建 Agent 到首次私信产生模型运行并写入该 Agent 自己的会话记录，由 `apps/control-plane/tests/control-plane/agent-loop.test.ts` 用真实控制面内 Pi 循环、本地 HTTP/SSE provider、WebSocket、节点与持久库覆盖；它在 macOS 与 Linux 上都会运行。数据目录的格式拒绝与日常接续见[运行手册](OPERATIONS.md#数据与日常接续)。

`message-tasks.test.ts` 沿用这些真实进程和持久库，验证消息及回复的多任务、两位 Agent 的明确认领与并发新增、消息草稿交错，以及任务提交后模型结果尚未确认时的控制面重启。模型输出由本地脚本 provider 指定，只验收工具和恢复能力；它不代表真实模型服务连接或 VPS 部署已验证。中文网页的标题输入和全部关联任务展示由 `apps/web/tests/chat-app.test.ts` 的现有交互接缝覆盖。

```sh
pnpm build
pnpm --filter @mate/control-plane exec vitest run tests/control-plane/message-tasks.test.ts
pnpm --filter @mate/web exec vitest run tests/chat-app.test.ts
```

普通命令执行在同一个现有普通账号下运行：Agent 的命令进入当前账号的 shell 子进程，默认使用该 Agent 的工作区，返回有界输出、退出码、截断与超时标记，命令里的 `sudo` 原样交给宿主。`agent-loop.test.ts`、`agent-loop-recovery.test.ts` 和 `agent-tool-invalidation.test.ts` 在真实控制面内 Pi 循环、WebSocket 和节点中核对命令/文件工具、控制面提交边界、节点重启收据复用与未知结果。`agent-loop-lifecycle.test.ts` 核对模型/摘要停滞时取消、凭据暂停、离线和同节点多 Agent 并发；`agent-loop-attention.test.ts` 核对忙时主动读取、暂缓、继续、下一轮同 session 与发言新鲜度选择：

```sh
pnpm build
pnpm --filter @mate/control-plane exec vitest run tests/control-plane/agent-loop.test.ts tests/control-plane/agent-loop-recovery.test.ts tests/control-plane/agent-tool-invalidation.test.ts
```

命令的失败与恢复语义另有一个只做真实进程工作的检查：它用真实 shell 子进程跑一条超时命令，模拟节点进程在命令运行中消失，再用同一份收据数据库把节点"重启"，确认同一操作 ID 重放记录而不是重跑命令：

```sh
pnpm build
pnpm test:linux-ordinary-command-failure
```

该检查以启动账号运行，不需要 root、容器或服务管理器，macOS 与 Linux 都可运行，并打印一行 JSON 证据；它记录 `kernel`、`linuxKernel` 与 `containerized`。它不覆盖宿主的 `sudo` 策略：普通账号无法终止 `sudo` 派生的 root 后代，Mate 对此不作任何声明。

`apps/node/tests/files/same-account-files.test.ts` 与 `apps/node/tests/provisioning/agent-workspace.test.ts` 覆盖文件工具在普通账号下的执行、工作区准备，以及节点以 root 运行时拒绝报告运行账号。`apps/control-plane/tests/control-plane/agents.test.ts` 覆盖控制面拒绝以 root 账号完成的 Agent 创建。**不要再引入以 root 运行节点、按 Agent 创建 Linux 账号或 Mate 管理 systemd 单元的检查**：这条路径已从实现、配置和说明中移除。

# Agent token 与缓存统计

所有者登录后，可携带登录 Cookie 请求 `GET /api/owner/agents/{agentId}/usage`。接口只读取指定 Agent 已由控制面确认的模型响应；Agent 不存在返回 404，未登录返回 401。响应设置 `Cache-Control: no-store`，不提供网页面板。

响应中的 `total`、`normal`、`summary` 分别是全部请求、普通请求和会话压缩摘要请求的累计；`latestNormal` 是最后一次普通请求的记录 ID、控制面确认时间 `recordedAt`（Unix 毫秒）和该次统计。没有普通请求时 `latestNormal` 为 `null`。失败响应只要返回并被确认，其实际报告的用量也计入；失败摘要不因此成为有效压缩。

每组的 `requestCount` 是已确认的模型响应数。`tokens` 分别列出 `uncachedInput`（未缓存输入）、`cacheRead`（缓存读取）、`cacheWrite`（缓存写入）、`allInput`（前三者之和）、`output`、`total`（全部输入加输出）和 `reasoningOutput`（若报告，是输出的子集，不再加到总数）。每个指标包含 `value`、`knownRequests` 和 `missingRequests`：只汇总供应商字段足以确定的请求；没有可确定的值时 `value` 为 `null`，真实零则为 `0`。供应商只报告包含缓存的输入时，不再次把缓存读取量加上去。

`cacheHitRate.value` 是具备完整缓存读取量及全部输入量、且全部输入大于零的同一组请求中，缓存读取 token 总数除以全部输入 token 总数。它是 token 加权的比例，缓存写入进入分母而不算命中，输出不进入分母。`knownRequests` 与 `missingRequests` 显示该比例覆盖了多少请求；缺字段或分母为零的请求不进入比例。没有请求、字段缺失或分母为零时比例为 `null`。这些数字只覆盖控制面收到并确认的响应，不估计供应商侧未送达的计费记录，也不构成用量或运行额度。

Pi 当前的 Google SDK 适配器不开放响应体截取，并把未报告的字段归一成零。Mate 对这一路径只将 Pi 返回的正值视为已报告；归一化零仍显示为未知，不能据此声称 Google 的缓存命中率为 0%。
