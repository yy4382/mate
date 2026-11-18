# 管理模块（`@palace/admin`）

> 总览见 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)。测试见 [TESTS.md](TESTS.md)。

## 职责

管理员通过管理模块管理 Agent、提供商 API key、配对与授权的 node、对话观察、工作区浏览和入站 webhook。`openAdmin` 打开控制库表和 `@palace/manager`，并把网关端口和 `@palace/plugins` 的各扩展组装进每个 Agent，使 Web 外壳不直接依赖 Manager 或 Plugins。

## 组装 Agent（`buildAgent`）与工作区端口（`gatewayAgentPorts`）

`openAdmin` 为 `openAgentManager` 提供 `prepareWorkspace: prepareGatewayWorkspace(...)` 与 `buildAgent(...)`：

1. 每次打开 Agent，`gatewayAgentPorts` 为它创建 `terminal`、`files`、`memory` 端口。关闭端口时停止仍在运行的终端会话。
2. 组装主对话扩展集合：`terminalExtension`、`filesExtension`、`memoryExtension`、`subagentExtension`、`reminders`、`historyExtension`、`idleCompaction`、`docsExtension([webhookDocsDirectory])`、`webhookExtension`（Manager 再在其后追加 `chatExtension`）。同时将 `reminders.background` 与 `idleCompaction.background` 传给 runtime，并在关闭或取消进行中的 `exec` 时去重发送 `terminal_write({ kill: true })` 且在 `ports.close()` 等待所有进行中清理完成后再返回。
3. **`subagent` 能力白名单：** 通过 `subagentExtension({ extensions: [terminal, files, memory, historyExtension, docs, compact.extension] })` 显式授权子对话可见扩展，结构上排除 `chatExtension`、`webhookExtension`、`reminders` 与递归的 `subagent`。

## 多 Node 调度与终端会话路由

- `files` 端口每次读取当前授权节点列表（`nodeAccess`），按 `node` 名字将 `read`/`write`/`edit` 转给在线目标 node 的工作区。
- `terminal` 端口将运行中会话路由（`activeSessionNodes`，不设上限并在发出 `terminal_exec` 前先登记，以免暂停或中断竞态丢失会话）与已结束会话路由（`settledSessionNodes`，FIFO 最多保留 1,024 条）分离，确保大量短命令不会挤掉仍在运行的长会话。每当 `terminal_exec` 返回 `running: true`，端口即附加一个被动的 `watchActiveSession`（`terminal_wait({ sessionId, observeOnly: true })`），让自然退出但未再被 `write_stdin` 或 `notify_on_exit` 查询过的后台会话也能立即从 `activeSessionNodes` 移入 `settledSessionNodes`。后续 `write` 和 `wait`（含 `CommandWatchTask` 的后台等待）均依据 `sessionId` 自动路由到原执行 node 并再次校验当前授权。
- 暂停时，管理模块先把目标 Agent、会话和 node ID 写入控制库的 `pending_terminal_stops`，再向该 node 发送 `terminal_write({ kill: true })`。收到停止确认后清除记录。节点离线、5 秒内未收到回执或收到 `stop-failed` 时，Agent 保持暂停，调用方收到 `503 stop-unconfirmed`。控制面重启后再次暂停会重试这些会话。删除 Agent 时同时清除它的记录。
- node 确认会话结束后，控制面保留有界路由，供并发的等待者领取结果。若 node 报告 `stop-failed`，控制面保留该会话以便再次停止。Agent 列表为仍有待确认命令的已暂停 Agent 返回 `pendingTerminalStops: true`，网页和移动端据此显示“重试停止命令”。
- `memory` 端口只从主 node 调用 `memory_read` 读取 `memory/MEMORY.md`；主 node 离线时返回 `{ status: "offline" }`。

## 观察、子 Agent 查询、模型与 Webhook

- `assistants(agentId)` 与 `watchAgent(agentId, listener, { assistant })` 保持既有对外和 HTTP 契约，内部通过 `@palace/plugins` 的 `listSubagents(runtime)` 与 `subagentConversationId(runtime, assistant)` 解析并观察对应子对话。
- `webhookExtension`（`src/webhook-plugin.ts`）以原生扩展导出系统提示段与 `webhookDocsDirectory`（`docs/webhooks.md`），经 `docsExtension` 按需提供给主对话和子对话。
- 提供商凭据、node 授权持久化、工作区浏览与控制库表规则保持原有边界不变。
