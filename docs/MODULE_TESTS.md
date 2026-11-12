# Palace 模块边界测试说明

> 所有模块共用的测试规则和替身。每个模块具体测什么写在它目录的 `TESTS.md` 里，见第 3 节。读这份之前先读 [ARCHITECTURE.md](ARCHITECTURE.md) 的第 2、4 节。

## 1. 规则

1. **只测模块边界，不写单元测试。** 测试只通过模块对外的接口（模块 `ARCHITECTURE.md` 列出的接口、HTTP 路由、WebSocket 协议、CLI 命令）驱动模块，只断言从接口上能观察到的结果。不 import 模块内部文件，不检查内部表结构，不 mock 模块内部的函数。
2. **边界外的依赖用替身。** 替身只能替换另一个模块或外部系统，不能替换被测模块自己的一部分。第 2 节列出允许的替身。
3. **失败和恢复路径与正常路径同等重要。** 每个模块都要覆盖：调用方重复调用、中途崩溃后重启、依赖方不可用。只跑通正常路径不算验收。
4. **测试要能说明"为什么"。** 每个测试名用一句完整的话描述行为，例如"同一个 requestId 重复发送只产生一条消息"。
5. **模型不是被测对象。** 模型由脚本扮演，测的是"模型做出某个选择之后，系统能否正确兑现"。不测模型会不会做出那个选择。
6. **假实现和真实集成要分得清。** 用了替身的测试不能叫"集成测试"。真实提供商和真实 VPS 的检查不在本文范围内。

## 2. 替身与测试工具

这些工具本身也是要写的代码，并且优先实现，因为后面每个模块的测试都依赖它们。

| 名称 | 替代什么 | 能力 | 用于 |
|---|---|---|---|
| **脚本化提供商** | 模型提供商 | 本地 HTTP 服务，按真实提供商协议（先做 OpenAI Responses）返回 SSE。脚本由命名步骤组成，每步收到真实请求体和请求带的 API key，可以回答文本（也可以是在输出上限处被截断的文本）、发起工具调用、只发一半、卡住不回、返回 4xx/5xx（和 OpenAI 一样，5xx 是会被重试的服务端错误，4xx 不是）。按会话 ID 区分不同 Agent 的请求；不带会话 ID 的请求（压缩的摘要请求）不属于任何会话，按请求体逐个认领。`assertComplete()` 检查：没有用完的步骤、没有多余的请求、没有未声明的取消，任何一项不满足都报错，并写明是哪个 Agent 的哪一步 | runtime、Manager、管理模块、系统场景 |
| **可控时钟** | 系统时间 | 测试推进时间，触发定时器；`sleeping(n)` 等到有 n 个定时器在睡，即被测代码的定时循环都已停下，用来断言"什么都没发生"而不靠等真实时间 | runtime（提醒、空闲压缩）、聊天 app（推送退避）、网关（心跳） |
| **故障存储适配器** | Durable 的 SQLite 适配器 | 包装真实的 SQLite 适配器，可以在第 N 次提交之前或之后让提交失败或挂起，或在含某条语句的提交完成之后挂起之后的一切（`freezeAfter`），用来模拟"写到一半崩溃" | runtime、连接器、聊天插件 |
| **假 node** | node 进程 | 实现 node 的 WebSocket 协议，测试控制工具调用：返回结果、流式输出、挂起、断开连接 | 网关、runtime、Manager |
| **假网关** | 控制面的 node 网关 | 实现网关一侧的协议：配对、认证、发送工具调用、断开连接 | node |
| **网络代理** | node 与控制面之间的 TCP 连接 | 三种模式：转发、黑洞（吞掉数据但不关闭连接）、断开 | 网关与 node 的心跳和重连 |
| **假服务管理器** | systemd、launchd、Task Scheduler 的外部命令 | 按测试设定的状态与服务定义回答，并记录操作；由公开 CLI 驱动 | node CLI |
| **进程夹具** | 无 | 以真实子进程启动控制面或 node，能 SIGKILL 后在同一个数据目录上重启 | 系统场景 |

**崩溃怎么模拟：** 优先用故障存储适配器，在进程内让提交在指定点失败或挂起，然后关闭并重新打开模块，比如重新调用 `AgentRuntime.open`。少数必须验证"进程真的死了"的场景用进程夹具 SIGKILL。不使用 eval 字符串或全局变量注入故障。

## 3. 各模块的测试

| 模块 | 测试说明 |
| --- | --- |
| 聊天 app | [packages/chat/TESTS.md](../packages/chat/TESTS.md) |
| Agent 插件契约 | 没有自己的测试，由 runtime 经 `openAgentRuntime` 和 `submit` 覆盖（[packages/agent-plugin](../packages/agent-plugin/ARCHITECTURE.md)） |
| Agent runtime | [packages/runtime/TESTS.md](../packages/runtime/TESTS.md) |
| 聊天插件、连接器与 Agent Manager | [packages/manager/TESTS.md](../packages/manager/TESTS.md) |
| Node 网关 | [packages/gateway/TESTS.md](../packages/gateway/TESTS.md) |
| Node 与 `palace node` CLI | [apps/node/TESTS.md](../apps/node/TESTS.md) |
| 管理模块 | [packages/admin/TESTS.md](../packages/admin/TESTS.md) |
| 控制面外壳 | [apps/control-plane/TESTS.md](../apps/control-plane/TESTS.md) |
| 网页客户端 | [apps/web/TESTS.md](../apps/web/TESTS.md) |
| 移动客户端 | [apps/mobile/TESTS.md](../apps/mobile/TESTS.md) |
| 系统场景 | [tests/system/TESTS.md](../tests/system/TESTS.md) |
| 自动部署 | [deploy/auto-update/TESTS.md](../deploy/auto-update/TESTS.md) |
