# 连接器与 Agent Manager 边界测试

> 设计见同目录的 [ARCHITECTURE.md](ARCHITECTURE.md)。所有模块共用的测试规则和替身见 [docs/MODULE_TESTS.md](../../docs/MODULE_TESTS.md)。

## 1. 连接器

**边界：** 聊天 app 的 `inboxEvents` / `unreadSummary`，以及向 `NoticeTarget`（`snapshot`、`commit`、`submit`）读取和提交的结果。

**替身：** 内存 `RecordingRuntime`（仅测连接器逻辑）；真实 `AgentRuntime` 配 `chatExtension` 与 `FaultyDatabase`（测崩溃恢复和 notice 替换）。

- 仅新消息事件触发 `notice:<eventId>` 并单调推进 `ChatCursorsDoc`；仅任务变化不发通知；空摘要只推进游标。
- 待交付旧通知被同前缀 `notice:` 替换；已交付给模型的新通知会连续呈现；提交后、存游标前崩溃重连不丢不重。

## 2. 聊天扩展

**边界：** 真实 runtime 装入 `chatExtension(account)` 发往 `ScriptedProvider` 与真实 `ChatApp` 的调用。

- 系统提示告知普通文本输出不会到达任何地方、所有发言必须走 `chat_send`。
- 发送遇到新消息被 `held` 并更新已读位置，重发或改写后正常通过。
- `chat_send` 与 `chat_read_unread` 崩溃重放按 `requestId` 幂等返回原结果，不重复发送或跨页。
- 以 Durable `configure` 配置为 `extensions: []` 的子对话无法调用任何聊天工具，`ChatApp` 无任何副作用。

## 3. Agent Manager

**边界：** `AgentManager` 接口与 `data/agents/` 目录。

**替身：** 真实 `ChatApp`、真实 runtime、`prepareWorkspace` + `buildAgent` 中的工作区测试扩展、`ScriptedProvider`。

- 创建、暂存失败重做、ID 冲突、坏文件隔离、重启按 `ManagerAgentStateDoc.paused` 选择性打开、暂停前后改配置、并发操作串行化。
- 暂停时先触发 `closing` 信号中止在途工具调用并停掉模型请求，恢复后从断点继续并交付期间累积的一条未读汇总通知。
- 关闭后关闭态文件读出 `ManagerAgentStateDoc.paused === false`。
