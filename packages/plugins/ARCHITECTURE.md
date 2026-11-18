# Agent 能力插件（`@palace/plugins`）

> 总览见 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)。测试见 [TESTS.md](TESTS.md)。

## 设计选择

`@palace/plugins` 直接导出原生的 `@earendil-works/pi-durable` `Extension`（及配套后台任务工厂），不额外包装自定义的插件契约。各能力模块相互独立，模块之间没有任何跨文件 import，也不通过工具名约定或作用域标签耦合；能力组合与子 Agent 可见范围全部由组装方（`@palace/admin`）通过显式的 `Extension` 正向白名单传给 `subagentExtension`。

## 能力清单

| 导出工厂 | 扩展名 | 工具与提示 | 状态与协作 |
|---|---|---|---|
| `terminalExtension(port, { closing })` | `terminal` | `exec_command`、`write_stdin`（均配置 `outputLimits: { retain: "tail" }`）；提示说明 `yield_time_ms`、`notify_on_exit` 和 `node` 路由 | 以 Durable 后台任务 `palace.terminal.watch` 按对话独立实现退出通知；node 端按对话隔离消费状态，同一对话主动用 `write_stdin` 看到退出后不会重复通知 |
| `filesExtension(port, { closing })` | `files` | `node_list`（每次现读）、`read`（`replay: "safe"`）、`write`、`edit`（`replay: "unsafe"`） | 可选 `node` 参数在端口分流前剥离 |
| `memoryExtension(port, { closing })` | `memory` | 仅位置提示段 `memory`（`{ tag: false }`） | 每次请求前从主 node 读取 `memory/MEMORY.md`（上限 64 KiB）；主 node 离线或读取失败时沿用 `input.shown["memory"]` |
| `subagentExtension({ extensions, roles? })` | `subagent` | `subagent`（前台或 `run_in_background: true`，支持 `resume` 和可选 `role`）、`subagent_stop` | 对话文档 `palace.subagents`；新建子对话时经 Durable `configure` 继承父对话模型与 thinking 并设置正向 `extensions` 白名单，禁止递归包含 `subagent` |
| `reminders(clock?)` | `reminders` | `reminder`（`set`、`list`、`cancel`）；返回 `{ extension, background }` | 对话文档 `mate.reminders`（上限 100 条），到期按 `requestId = reminder:<id>` 提交 |
| `historyExtension` | `history` | `history_search`、`history_read`（`replay: "safe"`） | 从 1 编号遍历可见记录；每页序列化严格控制在 40,000 字节内（低于 Durable 50 KB 工具结果上限） |
| `idleCompaction()` | `idle-compaction` | 无工具，仅在每次模型回应后唤醒后台循环；返回 `{ extension, background }` | `IDLE_POLICY` 按默认 / 提供商 / `provider/modelId` 三层覆盖；空闲达到 `compactAfterShare` 且超过阈值时向主对话提交检查点摘要请求，写入 `CompactionEntry` |
| `docsExtension(directories)` | `docs` | 仅当扫描到至少一个主题时暴露 `palace_docs({ topic })`（`replay: "safe"`） | 读取 `<topic>.md` 的 front matter `description` 生成工具索引 |

## 关键机制

### 1. 终端执行与 `notify_on_exit`

- `exec_command` 为每次调用分配 UUID 作为 `session_id`，传入 `yield_time_ms`（默认 10,000 ms，范围 0 到 120,000 ms）和可选 `timeout_ms`、`workdir`、`node`、`notify_on_exit`。
- `exec_command` 和 `write_stdin` 均显式设置 `outputLimits: { retain: "tail" }`，避免输出超过 Durable 默认的 2,000 行 / 50 KB 限制时按头部截断而丢失末尾的 `[Command still running ...; session_id: ...]` 与 `[Exit notification armed: ...]` 行。
- 若命令在 `yield_time_ms` 内结束，立即返回完整结果；否则返回 `running: true` 和 `session_id`。之后模型可用 `write_stdin({ session_id, chars?, eof?, kill?, yield_time_ms?, notify_on_exit? })` 写入 stdin、关闭输入、强杀或追加读取。若 node 未能终止进程，错误结果也会给出 `session_id`，模型可用 `write_stdin({ session_id, kill: true })` 重试。
- 当 `exec_command` 或同一会话上的 `write_stdin` 传了 `notify_on_exit: true` 且命令仍在运行时，扩展在当前对话下创建一条按对话去重的 `palace.terminal.watch` Durable 后台任务，携带 `conversationId` 调用 `port.wait` 挂起等待；不同对话（如父对话与子 Agent）可各自独立监视同一 `session_id`，仅当当前对话尚未通过 `write_stdin` 消费该次退出时才以 `whenBusy: "steer"` 提交 `<command_notification>`。

### 2. 子 Agent 与后台任务通用等待

- `subagent` 默认前台等待结果，传 `run_in_background: true` 时立即返回 `{ status: "running", agent_id }` 并由后台任务在完成后向父对话 `steer` 投递 `<subagent_result>`。
- 子 Agent 即使调用了 `notify_on_exit: true` 后提前结束自身 turn，也不需要在 `subagent` 里 import `terminal` 模块：`waitForChildRun` 结合 `inspectAndListLive` 与 `raceAnyTask` 同时竟等子对话下所有非终态任务及空闲状态，只要在运行期间启动（`item.id > baselineTaskId`）的任一 `GenerationTask` 或后台任务以 `failed`、`faulted` 或 `orphaned` 结束，就立刻中止子对话其余挂起的后台任务（`child.abort(context, { background: true })`）并向上层汇报失败，而不会死等另一个仍在挂起的 `CommandWatchTask`；成功时跳过后续 `UserEntry` 以提取最新一轮回复。
- `subagent_stop` 在 `palace.subagent.control` 写取消标记后中止子对话并等待对应运行任务结束，不向父对话发送结果；子对话上下文仍保留以便后续 `resume`。

### 3. 记忆目录与系统提示

- 主 node 工作区初始化 `./memory/` 目录而不预写根 `MEMORY.md`，命令环境注入 `PALACE_MEMORY_DIR`。
- 只有 `memory/MEMORY.md` 会在每轮模型请求前自动注入系统提示，其余笔记、脚本和主题文件由模型通过命令或文件工具在 `./memory/` 下自行组织。
