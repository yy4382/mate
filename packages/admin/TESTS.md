# 管理模块边界测试

> 设计见同目录的 [ARCHITECTURE.md](ARCHITECTURE.md)。所有模块共用的测试规则和替身见 [docs/MODULE_TESTS.md](../../docs/MODULE_TESTS.md)。

**边界：** `Admin` 公开接口及 HTTP 路由（经 Web 外壳）。

**替身：** 真实 `AgentManager`、真实 `AgentRuntime` 与 `ChatApp`、真实 `NodeGateway` 配 `FakeNode`、`ScriptedProvider`。

## 覆盖范围

- **Agent 生命周期与暂停（`agents.test.ts`）：** 创建 Agent 时按选择的主 node 准备 `home` 工作区；重启后命令仍跑在该 node；暂停通过真实网关向在线 node 发送停止消息并等待进行中/已 yield 终端会话的 `kill: true` 清理完成后才返回，恢复后向模型报告未完成、不重跑；当停止请求超时（`Clock` 5 秒）或 node 返回 `stop-failed` 时，本地状态记为 `paused` 且 `pauseAgent` 抛出 `stop-unconfirmed`，链路恢复后重试 `pauseAgent` 确认终止并返回成功；超过 1,000 条自然退出的 `running: true` 会话会通过 `observeOnly` 监视即时移出 `activeSessionNodes`，暂停时不会发送陈旧的 `kill: true` 请求；超过 1,024 条短命令不会驱逐活跃长会话的路由；未声明新能力的旧主 node 在多轮对话中保持在线（`memory_read` 由网关本地拒绝）；列出状态、名称与用量；加载主 node 的 `memory_read`（`memory/MEMORY.md`）进每轮系统提示。
- **多 Node 授权（`node-grants.test.ts`）：** 未授权和未知 node 均被拒绝且不请求 node；在线授权即时准备 `visit` 工作区；收回授权阻止新调用而不打断已发出的调用；离线授权在重连后首次使用时完成。
- **观察与子 Agent（`transcript.test.ts`、`watch-ends.test.ts`）：** 流式观察文本与 `exec_command` 工具调用；启动后台 `subagent` 后通过 `assistants()` 返回 `["sub-1"]` 并按名字观察子对话，拒绝不存在的名字；验证子对话拥有 `exec_command`、`read`、`palace_docs` 而无 `chat_send`、`subagent`、`reminder`。
- **模型、API Key 与浏览（`providers.test.ts`、`nodes.test.ts`、`workspace.test.ts`、`refusals.test.ts`）：** 热换 Key、拒绝无效 thinking、配对与改名、工作区浏览限制和并发拒绝边界。
- **数据迁移（`migration.test.ts`）：** 以 `v0.1.0-alpha.2` 与 `v0.1.0-alpha.10` 真实发布存储夹具（含既有 `mate.agent-state` 与控制库表）验证无损升级。
- **Webhook（`webhooks.test.ts`）：** `<external_webhook_content>` 包裹、转义、按幂等键去重、秘密校验、轮换与删除，以及通过 `palace_docs` 读取 `webhooks` 文档。
