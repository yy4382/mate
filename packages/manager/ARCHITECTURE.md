# Agent Manager 和连接器（`@palace/manager`）

> 总览见 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)。测试见 [TESTS.md](TESTS.md)。

## Agent Manager

### 职责

管理所有 Agent 的生命周期并打开或关闭它们的 runtime。Manager 是唯一能打开 runtime 的地方。

### 接口

`openAgentManager({ directory, chat, prepareWorkspace, buildAgent?, credentials, clock?, report? })`，签名在 `src/index.ts`。

- `prepareWorkspace(nodeId, agentId)` 创建或幂等确认 Agent 在主 node 上的工作区。
- `buildAgent({ agentId, nodeId, clock, closing })` 为即将打开的 Agent 组装原生 `pi-durable` 扩展（`extensions`）、后台循环（`background`）与关闭清理钩子（`close`）。Manager 自身在其后追加该 Agent 的 `chatExtension`。
- `report(error, agentId)` 接收打不开的 Agent、出错的连接器和存储失败的 runtime，不让进程崩溃。
- `AgentManager` 提供 `list`、`create`、`delete`、`pause`、`resume`、`describe`（`open`、`paused` 或 `closed`）、`configure`、`runtime(id)` 和 `close`。

### 规则

1. **一个 Agent 存在，当且仅当 `data/agents/<id>.sqlite` 存在。** 启动时扫描目录，打开所有没暂停的 Agent，只认 `<UUID>.sqlite`。
2. **每个 Agent 拥有独立的持久文档 `ManagerAgentStateDoc`（`kind: "mate.agent-state"` v1，存储 `{ paused, nodeId }`）。** 该文档身份由 Manager 持有，保持原有 `kind` 与结构以兼容既有 Agent 存储文件。
3. **同一个 Agent 的生命周期操作串行执行**，确保任一时刻最多一个打开的 runtime。
4. **暂停就是立刻关闭。** `#stop` 先触发传给 `buildAgent` 的 `closing` 信号，再停止连接器、关闭 runtime、调用 `built.close()`，最后只在关闭状态下把 `paused: true` 写进 `ManagerAgentStateDoc`。
5. **创建顺序：** 分配 ID -> `chat.ensureAccount` -> `prepareWorkspace` -> `createAgentStore`（写入 `nodeId`）-> 原子改名 -> 打开 runtime。`prepareWorkspace` 或建库失败抛出 `AgentCreationFailed`，可用原 ID 幂等重做。

## 聊天扩展（`chatExtension`）

### 职责

提供 `chat` 扩展（`chat_read_unread`、`chat_read_history`、`chat_search_messages`、`chat_send`、`chat_create_task`、`chat_change_task`、`chat_open_dm`、`chat_list_dms`、`chat_list_tasks`）与主对话系统提示及 `renderNotice`。管理模块构造 `subagent` 白名单时只传入安全能力，不列入 `chat`，从而在结构上隔离聊天工具。

- 所有工具只经 `AccountChat`（`ChatApp.forAccount(account)`）操作聊天 app。
- 工具全部声明或保持以 `requestId = tool:<Durable 工具任务 ID>` 幂等，发送和任务操作固定携带 `freshness: true`。

## 连接器（`connectInbox`）

### 职责

把聊天 app 的收件事件变成通知提交给 runtime，只依赖 `NoticeTarget`（`snapshot`、`commit`、`submit`）。事件位置存在 Manager 持有的会话级 Durable 文档 `ChatCursorsDoc`（`kind: "mate.cursors"` v1，`positions["chat-inbox"]`）。

- 按存储位置读取新收件事件；有未读摘要时提交 `requestId = notice:<最新事件 ID>`、`whenBusy: "steer"`、`replaces: "notice:"`。
- 提交后再单调推进 `ChatCursorsDoc`，因此提交后、存游标前崩溃会重提交相同 `requestId`，由 Durable 去重。
