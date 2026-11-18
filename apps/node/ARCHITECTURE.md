# Node（`@palace/node`）

> 总览见 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)。网关一侧见 [packages/gateway/ARCHITECTURE.md](../../packages/gateway/ARCHITECTURE.md)。安装、服务管理和 `palace node` 各命令的行为见 [DEPLOYMENT §3.2](../../docs/DEPLOYMENT.md)。测试见 [TESTS.md](TESTS.md)。

## 职责

node 是一台 Linux、macOS 或 Windows 机器上以宿主现有账号运行的进程，由 `palace node` CLI 管理。它只负责执行：在属于某个 Agent 的工作区里管理终端会话、读取 `memory/MEMORY.md` 以及读写文件。node 从不接触模型凭据和对话记录，也不判断授权。

## 工作区与记忆入口

文件工具的相对路径以 `<工作区根>/<agentId>` 为根，绝对路径必须在这个目录内。各 node 的文件互相独立，不同步。

主 node（`home`）的工作区在创建 Agent 时由管理模块显式准备，创建 `<workspace>/memory/` 目录（已有文件不覆盖，也不预写根 `MEMORY.md`）。之后执行工具前只检查目录存在，缺失时报错，不重建。获准访问的 node（`visit`）在显式准备和每次执行前都准备工作区，不初始化 `memory/`，准备失败就不执行工具。浏览工作区只读，不创建目录。

`memory_read`（`src/memory.ts`）通过 `WorkspaceEnv`（限定工作区根目录）按流式二分安全方式读取 `<workspace>/memory/MEMORY.md`（最多返回 64 KiB，超出标明 `truncated`，缺失返回 `{ status: "missing" }`）。

## 文件工具

`read`、`write`、`edit` 直接用 Durable 自带的工具，跑在限定于工作区的 `NodeExecutionEnv` 上。参数修复和校验、抛错变成错误结果、诊断附在内容后面，都和 Durable 在本地执行时一样。

## 终端会话（`TerminalSessions`）

node 不直接使用 Durable 的单次执行工具，而是通过 `src/terminal-sessions.ts` 在当前 node 进程中维护多步会话，支持流式交互与单消费者结束通知：

- **`terminal_exec`：** 为一次命令创建会话（按 `(agentId, sessionId)` 索引），标准输入为普通管道（stdin pipe，非 PTY）。若命令在 `yieldTimeMs`（默认 10,000 ms，范围 0 到 120,000 ms）内结束，直接返回完整 `TerminalOutcome`；超时仍在运行时返回 `{ running: true, sessionId }` 并将会话转入后台挂起监控。硬超时 `timeoutMs` 最大一天。若 `terminal_write({ kill: true })` 先于会话建立到达（`#killedBeforeStart`），会在启动窗口立即终止而不遗漏。
- **`terminal_write`：** 依据 `(agentId, sessionId)` 发送输入、关闭 stdin、轮询输出或终止进程。已有会话在工作区目录被移动后仍可访问。并发的 `terminal_wait` 可以取得结束结果，已通过写入或终止操作消费退出结果的对话会收到 `consumed: true`。node 保留最近 256 个已结束会话的结果。系统拒绝终止进程时，调用返回 `stop-failed`，后续 `kill: true` 可在同一会话上重试。
- **`terminal_wait`：** 默认给控制面 `CommandWatchTask` 使用，内部以并发等待者集合 `session.waiters.wait` 挂起，允许多个对话（如父对话与子 Agent）同时等待同一会话并各自拿到完整的结束状态；只有发起过 `terminal_write` 并消费了退出结果的那个 `conversationId` 会收到 `{ consumed: true }`。传入 `observeOnly: true` 时仅注册到被动的 `session.observers` 集合，不消费对话通知，也不因等待中止而停止命令；当会话已不在 `#active`（包括超过 256 条已从 `#settled` 淘汰的会话）时立即返回 `{ consumed: true }`，供控制面在命令自然退出后及时清理活跃路由。
- **平台执行：** Linux 和 macOS 使用 node 账号的 Bash 或 zsh（记录每对话最近工作目录），Windows 使用 `powershell.exe -NoProfile -Command`。命令进程组跟踪与僵尸进程处理在各平台共用同一套 `Commands` 状态机。

## 环境变量与启动快照（Linux/macOS）

命令在 node 账号的 Bash 或 zsh 里执行，POSIX 上 HOME 是账号主目录，Windows 上是工作区。每条命令的环境变量都注入：

- `PALACE_AGENT_ID`
- `PALACE_MEMORY_DIR=<workspace>/memory`

`src/shell-snapshot.ts` 在复原账号启动环境变量前会保留所有以 `PALACE_` 开头的环境变量，确保 `$PALACE_MEMORY_DIR` 等注入变量在 Bash 和 zsh 的增量 reset 循环中不会被清除。

## 停止、服务与持久化

连接断开时，`Executor.connectionClosed()` 停止该连接对应的活跃终端会话与进行中调用；`connection.ts` 在 `node.authenticate` / `node.pair` 中上报当前支持的工具列表（`tools`），并以有界 `yieldedSessions` 记录刚转入后台的 `terminal_exec` 映射（`requestId -> sessionId`），使控制面刚发出 `running` 后紧随而至的 `gateway.stop.tool` 仍能通过 `executor.stopSession` 终止对应会话；node 正常关闭时清理所有活跃进程组。`palace node` CLI、服务定义、清单验证及身份存储布局保持原有规则不变。
