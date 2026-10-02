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

`apps/node/tests/execution/same-account-files.test.ts` 与 `apps/node/tests/nodes/agent-provisioner.test.ts` 覆盖文件工具在普通账号下的执行、工作区准备，以及节点以 root 运行时拒绝报告运行账号。`apps/control-plane/tests/control-plane/agents.test.ts` 覆盖控制面拒绝以 root 账号完成的 Agent 创建。**不要再引入以 root 运行节点、按 Agent 创建 Linux 账号或 Mate 管理 systemd 单元的检查**：这条路径已从实现、配置和说明中移除。

# Agent token 与缓存统计

所有者登录后，可携带登录 Cookie 请求 `GET /api/owner/agents/{agentId}/usage`。接口只读取指定 Agent 已由控制面确认的模型响应；Agent 不存在返回 404，未登录返回 401。响应设置 `Cache-Control: no-store`，不提供网页面板。

响应中的 `total`、`normal`、`summary` 分别是全部请求、普通请求和会话压缩摘要请求的累计；`latestNormal` 是最后一次普通请求的记录 ID、控制面确认时间 `recordedAt`（Unix 毫秒）和该次统计。没有普通请求时 `latestNormal` 为 `null`。失败响应只要返回并被确认，其实际报告的用量也计入；失败摘要不因此成为有效压缩。

每组的 `requestCount` 是已确认的模型响应数。`tokens` 分别列出 `uncachedInput`（未缓存输入）、`cacheRead`（缓存读取）、`cacheWrite`（缓存写入）、`allInput`（前三者之和）、`output`、`total`（全部输入加输出）和 `reasoningOutput`（若报告，是输出的子集，不再加到总数）。每个指标包含 `value`、`knownRequests` 和 `missingRequests`：只汇总供应商字段足以确定的请求；没有可确定的值时 `value` 为 `null`，真实零则为 `0`。供应商只报告包含缓存的输入时，不再次把缓存读取量加上去。

`cacheHitRate.value` 是具备完整缓存读取量及全部输入量、且全部输入大于零的同一组请求中，缓存读取 token 总数除以全部输入 token 总数。它是 token 加权的比例，缓存写入进入分母而不算命中，输出不进入分母。`knownRequests` 与 `missingRequests` 显示该比例覆盖了多少请求；缺字段或分母为零的请求不进入比例。没有请求、字段缺失或分母为零时比例为 `null`。这些数字只覆盖控制面收到并确认的响应，不估计供应商侧未送达的计费记录，也不构成用量或运行额度。

Pi 当前的 Google SDK 适配器不开放响应体截取，并把未报告的字段归一成零。Mate 对这一路径只将 Pi 返回的正值视为已报告；归一化零仍显示为未知，不能据此声称 Google 的缓存命中率为 0%。

## 提示词构建与本地诊断

提示词统一入口为 `apps/control-plane/src/prompts/index.ts`。`system.ts` 按固定顺序构建普通 Agent 系统提示：前三段来自本次 run 的 profile（name、role、description），其余段为固定约定；每段与原文一起声明源码位置和启用条件。`runtime.ts` 单独构建输入来源、忙时通知、运行/上下文恢复、收据更正和摘要回填的用户消息。`summary.ts` 只构建一次性摘要请求（初始、更新、长轮次前缀），将历史转为临时文本，不提供工作工具。调用方仍负责调度、容量判断、持久提交和恢复。

先构建，然后查看来源、顺序、角色及启用条件；默认不输出正文，不读运行目录、数据库或环境凭据：

```sh
pnpm build:control-plane
pnpm prompt:inspect
pnpm prompt:inspect --show-content
```

`--show-content` 在没有快照参数时仅显示合成 profile 的最终 system prompt 和逐段文本，与 AgentLoop 使用同一构建函数。真实运行的完整 system prompt 和工具 schema 仍由现有 configuration 会话记录保存，不另建配置或复制 schema。需要核对某次运行时，将那一条记录的 `payload_json`（或其中的 `configuration` 对象）保存到自己控制的私密 JSON 文件，再显式指定：

```sh
pnpm prompt:inspect --snapshot /ABSOLUTE/private/configuration.json
pnpm prompt:inspect --snapshot /ABSOLUTE/private/configuration.json --show-content
```

快照默认仅报告类型、工具数量及来源可用性；加 `--show-content` 才显示该快照原有的最终 system prompt 和工具 schema。它们可能包含私密 profile 或描述，输出和快照都不应提交到 Git。诊断不输出快照中无关字段或凭据字段，失败也不回显文件名或输入内容。现有快照没有分段来源，诊断会标记 `unavailable-in-snapshot`，不会用今天的模板冒充历史来源；当前源码的来源清单用不带 `--snapshot` 的命令查看。

`prompt-characterization.test.ts` 的快照冻结于重构前实现 `b0dfb0dc`，使用合成数据核对普通请求/配置、恢复通知、三类摘要请求及恢复后上下文顺序。它是保持旧输出的回归基线；重构时不要用更新快照来消除差异。注意力选择、压缩失败/中断和持久恢复仍由现有集成测试覆盖。

## Agent 已确认历史检索

Agent 通过 `tools.list` / `tools.describe` 发现 `history.search` 与 `history.read`，再由 `tools.call` 调用。两个工具沿用当前 run、node、Agent 核验，不接受目标 Agent；只观察调用者自己的已确认 `kind=message` 原记录，不改变注意力、任务、权限、压缩点或操作收据。配置、用量、流式未确认片段和未消费的 pending correction 不在结果中。压缩只改变后续上下文，原记录 ID、来源、时间和正文继续可读；旧历史不是当前指令或重新执行工具的授权。

搜索和读取共用确定性文字投影：字符串正文保持原样；内容块按原顺序以换行分隔，`text` 只取文字，`toolCall` 写为 `工具调用 名称 (ID)` 加换行和 JSON 参数，其他块写为 `[非文字内容已省略]`。`toolResult` 在正文前写入 `工具结果 名称 (ID)`。图片、隐藏思维、协议签名及其他扩展字段不输出。原正文中的频道及可见范围标记不从当前对话状态重建。结果同时给出记录 `id`、`agentId`、`seq`、`runId`、`actionScopeId`、`role`、原消息 `timestamp`、持久确认 `confirmedAt`（均为 Unix 毫秒时间）及 assistant 的 `toolCalls` 或结果的 `toolCallId` / `toolName` / `isError`。

`history.search({query, cursor?})` 使用大小写敏感的字面子串，不解释正则。空字符串及包含未配对代理字符的查询拒绝。每次按 `seq` 升序扫描最多 100 条，返回最多 20 条，每条只报首个命中。`match` 为完整命中的 `[start,end)`；`excerpt` 带文字和自己的 `[start,end)`，最多 400 个 UTF-16 代码单元，命中前保留最多约 100 单元，边界不切代理对。长查询的命中可超过摘录，应按 ID 续读。所有范围均从投影文字的 0 开始。

首请求固定调用者当时最高消息 `seq`；原样携返回的 `nextCursor` 和同一查询继续，直到 `nextCursor=null`。游标包含 Agent、原查询、固定上界 `through` 和已扫描位置 `after`，不是权限凭证；服务端校验字段类型、非负安全整数、`after<=through`、上界未超出自己的已确认记录，以及 Agent/查询匹配。空命中但游标非空时仍可继续；命中满 20 条只推进到最后处理的记录，新追加消息需新搜索。

`history.read({id, offset?, maxChars?})` 默认从 0 返回最多 8,000 个 UTF-16 代码单元，`maxChars` 为 2 至 16,000。返回 `text`、`offset`、`nextOffset`、`totalLength` 和同 Agent 的 `previousId` / `nextId`；按 `nextOffset` 续读不会静默丢失尾部。offset 等于总长度时返回空片段和 `nextOffset=null`，超界或位于代理对中间则拒绝。未知记录 ID 和他人记录 ID 使用同一拒绝。

这些限制是观察分页约束，不是 Agent 运行或用量额度。100 条记录的上限不保证固定 CPU、内存或读取字节成本：巨型原消息仍需读取、解析并构造整个文字投影，分段阅读也有这一成本；首版不引入全文索引或改写原始历史。
