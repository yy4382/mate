# Agent 能力插件边界测试（`@palace/plugins`）

> 设计见同目录的 [ARCHITECTURE.md](ARCHITECTURE.md)。共用测试规则与替身见 [docs/MODULE_TESTS.md](../../docs/MODULE_TESTS.md)。

**边界：** 各 `Extension` 公开工厂，经 `@palace/runtime`（`openAgentRuntime`）发给脚本化提供商的模型请求与工具端口调用。

**替身：** 内存实现的工作区/终端/文件/记忆端口、`ScriptedProvider`、`FakeClock`、`FaultyDatabase`。

## 覆盖范围

- **`terminal`（`terminal.test.ts`）：** 前台快速完成不建监视任务；超时 yield 后通过 `write_stdin` 发送标准输入并接收完整结果；超过 3,000 行的 yield 输出保留尾部及 `session_id`；启用 `notify_on_exit` 在 turn 结束后收到 `<command_notification>`；`write_stdin` 已消费退出时 `wait` 返回 `{ consumed: true }` 且不重复触发 `<command_notification>`。
- **`files`（`files.test.ts`）：** `node_list` 每次现读在线节点列表；`read`/`write`/`edit` 转发时保留或省略 `node`；`read`（`replay: "safe"`）在崩溃恢复后自动重放，而 `write`（`replay: "unsafe"`）只执行一次并向模型返回中断错误。
- **`memory`（`memory.test.ts`）：** 从 `MemoryPort` 加载 `memory/MEMORY.md` 注入系统提示；文件缺失给出引导提示；主 node 离线或不可读时复用 `input.shown["memory"]` 缓存，不破坏提示前缀。
- **`docs`（`docs.test.ts`）：** 无文档时不暴露工具；多目录汇总主题；重名主题在构造期拒绝；返回原始正文并拒绝未知主题。
- **`history`（`history.test.ts`）：** 400 轮调用后分页输出仍是合法 JSON 且小于 40,000 字节；只将用户输入、模型回答与工具结果纳入编号并准确返回 `inContextFrom`。
- **`idle-compaction`（`idle-compaction.test.ts`）：** 分别覆盖阈值（2/3 线与 200k 上限）、5/6 缓存寿命等待、崩溃重连保留计时、请求中被拒绝不写入、非文本回答跳过、关闭中止和 `CompactionEntry` 替换旧前缀。
- **`reminders`（`reminders.test.ts`）：** 定时提交 `reminder:<id>`、重启期间到期补发且不重复、`cancel` 与列表状态、提交前崩溃仅投递一次。
- **`subagent`（`subagent.test.ts`）：** 前台/后台/恢复、正面 `extensions` 白名单隔离父能力与禁止递归、子对话继承父模型与 thinking、与 `terminal` 的 `notify_on_exit` 组合时父对话等待子对话后台任务彻底 settled 再回传结果、后续唤醒轮次失败时向前/后台父对话准确传播错误而不误用前一轮文本、父子对话同时监视同一 `session_id` 时各自收到通知、`subagent_stop` 干净取消不投递结果。
