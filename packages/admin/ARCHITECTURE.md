# 管理模块（`@palace/admin`）

> 总览见 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)。测试见 [TESTS.md](TESTS.md)。

## 职责

管理员通过管理模块管理 Agent、提供商 API key、配对与授权的 node、对话观察、工作区浏览和入站 webhook。`openAdmin` 打开控制库表和 `@palace/manager`，并把网关端口和 `@palace/plugins` 的各扩展组装进每个 Agent，使 Web 外壳不直接依赖 Manager 或 Plugins。

## 组装 Agent（`buildAgent`）与工作区端口（`gatewayAgentPorts`）

`openAdmin` 为 `openAgentManager` 提供 `prepareWorkspace: prepareGatewayWorkspace(...)` 与 `buildAgent(...)`：

1. 每个打开的 Agent 通过 `gatewayAgentPorts(gateway, store, nodeId, agentId)` 构造 `terminal`、`files`、`memory` 端口以及关闭清理函数 `close()`。
2. 组装主对话扩展集合：`terminalExtension`、`filesExtension`、`memoryExtension`、`subagentExtension`、`reminders`、`historyExtension`、`idleCompaction`、`docsExtension([webhookDocsDirectory])`、`webhookExtension`（Manager 再在其后追加 `chatExtension`）。同时将 `reminders.background` 与 `idleCompaction.background` 传给 runtime，并在关闭或取消进行中的 `exec` 时去重发送 `terminal_write({ kill: true })` 且在 `ports.close()` 等待所有进行中清理完成后再返回。
3. **`subagent` 能力白名单：** 通过 `subagentExtension({ extensions: [terminal, files, memory, historyExtension, docs, compact.extension] })` 显式授权子对话可见扩展，结构上排除 `chatExtension`、`webhookExtension`、`reminders` 与递归的 `subagent`。

## 多 Node 调度与终端会话路由

- `files` 端口每次读取当前授权节点列表（`nodeAccess`），按 `node` 名字将 `read`/`write`/`edit` 转给在线目标 node 的工作区。
- `terminal` 端口将运行中会话路由（`activeSessionNodes`，不设上限并在发出 `terminal_exec` 前先登记，以免暂停或中断竞态丢失会话）与已结束会话路由（`settledSessionNodes`，FIFO 最多保留 1,024 条）分离，确保大量短命令不会挤掉仍在运行的长会话。后续 `write` 和 `wait`（含 `CommandWatchTask` 的后台等待）均依据 `sessionId` 自动路由到原执行 node 并再次校验当前授权。
- 若 `exec` 在返回 `running: true` 前或返回后被关闭/中止（例如 `pauseAgent`），端口以 `killSession` 去重（记录在 `pendingKills` 并带 5 秒超时保护）向目标 node 发送 `terminal_write({ kill: true })`；`ports.close()` 会等待所有挂起的 `killSession` 完成，确保暂停返回后命令不会继续修改工作区。
- 当 `write` 观察到会话结束时，路由条目由 `activeSessionNodes` 移至 `settledSessionNodes`，使并发待决的 `terminal_wait` 仍可到达目标 node；当 `exec` 直接结束、报错或完成 `wait` 时彻底清理对应条目。
- `memory` 端口只从主 node 调用 `memory_read` 读取 `memory/MEMORY.md`；主 node 离线时返回 `{ status: "offline" }`。

## 观察、子 Agent 查询、模型与 Webhook

- `assistants(agentId)` 与 `watchAgent(agentId, listener, { assistant })` 保持既有对外和 HTTP 契约，内部通过 `@palace/plugins` 的 `listSubagents(runtime)` 与 `subagentConversationId(runtime, assistant)` 解析并观察对应子对话。
- `webhookExtension`（`src/webhook-plugin.ts`）以原生扩展导出系统提示段与 `webhookDocsDirectory`（`docs/webhooks.md`），经 `docsExtension` 按需提供给主对话和子对话。
- 提供商凭据、node 授权持久化、工作区浏览与控制库表规则保持原有边界不变。
