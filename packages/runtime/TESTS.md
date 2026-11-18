# Agent runtime 边界测试

> 设计见同目录的 [ARCHITECTURE.md](ARCHITECTURE.md)。所有模块共用的测试规则和替身见 [docs/MODULE_TESTS.md](../../docs/MODULE_TESTS.md)。

**边界：** `AgentRuntime` 接口、`createAgentStore`、`readAgentFile`、`configureAgentFile`，以及发给模型提供商的 HTTP 请求。

**替身：** `ScriptedProvider`、`FaultyDatabase`、`FakeClock`、测试中直接构建的原生 `pi-durable` `Extension`。

## 覆盖范围

- **Loop 与上下文（`runtime.test.ts`）：** 多次输入前缀连续递增；跨 Agent 隔离；超出窗口自动压缩与提供商 413 上下文过长重试；失败或截断摘要不替换原上下文；动态切换模型与 thinking 级别；通过 `openAgentRuntime({ extensions, background })` 注入测试扩展与后台循环；重名扩展拒绝打开；多扩展与子对话作用域通过 `configure` 正向设置白名单。
- **收件箱与去重（`inbox.test.ts`）：** 同 `requestId` 去重；忙碌期 `steer` 插入当前轮次之后；`withdraw` 撤回未交付输入；`replaces` 前缀替换仍在排队的旧输入并在崩溃恢复后仍只交付一次。
- **工具调用与崩溃恢复（`tools.test.ts`）：** 流式参数未完成时崩溃不执行工具；`replay: "safe"` 重放而 `replay: "unsafe"` 返回中断错误；提供商复用相同 call ID 时仍按 Durable 工具任务 ID 独立执行；流式输出进度。
- **关闭与存储故障（`lifecycle.test.ts`）：** `close()` 立即中止进行中的模型请求（发前、等头、流中、摘要）和工具调用的 `AbortSignal`；存储写入失败触发一次 `onFatal`、解除等待调用并结束所有 `watchEvents`；重启后从已提交点继续；`readAgentFile`、`configureAgentFile`、`withAgentFileSession` 读写关闭状态的存储文件。
- **模型目录与用量（`models.test.ts`）：** 凭据热更新；缺失密钥未发请求直接失败；用量统计准确反映模型 token。
- **事件观察（`events.test.ts`）：** 快照初始化、流式事件、子对话 `conversationId` 定向观察、`watchEvents` 不写存储并在 `close()` 时结束。
