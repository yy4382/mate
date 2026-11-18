# Agent runtime（`@palace/runtime`）

> 总览见 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)。测试见 [TESTS.md](TESTS.md)。

## 职责

`@palace/runtime` 是 `pi-durable` Harness 的薄封装，只负责打开与管理单个 Agent 的 Durable 存储和生命周期，不包含聊天、终端、文件、记忆、子 Agent、提醒、历史、空闲压缩或按需文档等具体业务能力（这些能力全部以原生 `pi-durable` `Extension` 的形式落在 [@palace/plugins](../plugins/ARCHITECTURE.md)、[@palace/manager](../manager/ARCHITECTURE.md) 和 [@palace/admin](../admin/ARCHITECTURE.md) 中）。

每个 Agent 对应一个 runtime、一个 Durable Harness 和一个 SQLite 文件。存储中的多个对话（主对话与各子对话）共享模型凭据查询，并在调用 `configure()` 时同步更新模型设置。

## 接口

给 `@palace/manager`、`@palace/plugins` 与测试使用，签名在 `src/index.ts`：

- `createAgentStore(file, { settings, init? })` 在临时文件创建 Durable 根对话、写入初始模型设置与调用方初始文档，最后原子改名为正式文件。
- `openAgentRuntime({ file, credentials, extensions?, background?, resolveModel?, wrapDatabase?, onFatal?, onReport?, clock? })` 检查扩展名唯一性，全部注册进 Durable registry 并传给主对话的 `settings.extensions`，打开 Harness 后调用 `resume()`，然后启动 `background` 循环。`credentials(provider)` 在每次模型请求时现读。存储适配器发生致命故障时触发一次 `onFatal`。
- `AgentRuntime` 暴露 `rootConversationId`、`submit`（支持 `replaces` 撤回未交付的同前缀排队输入）、`withdraw`、`snapshot`、`commit`、`configure`、`settings`、`idle`、`usage`、`watchEvents`（按 `conversationId` 观察主对话或任意子对话）和 `close`。
- 在未打开 runtime 的关闭存储文件上提供只读/事务辅助函数 `withAgentFileSession`、`readAgentFile` 和 `configureAgentFile`，供 Manager 读取元数据、切换暂停状态与修改离线配置。
- `catalogModels(provider)` 读取 `pi-ai` 内置模型目录。

## 规则

1. **所有业务能力都是原生 `Extension`。** runtime 不定义专有插件层，也不假设安装哪些扩展；各包通过 `openAgentRuntime({ extensions, background })` 直接注入。
2. **凭据不落 Agent 文件，按次现读。** `agentModels` 绑定 `closing` 信号，关闭或中止时立即取消所有挂起的模型 HTTP 请求。
3. **配置改动不追溯。** 已发出的请求按旧配置完成，新配置从下一次模型请求生效。
4. **用量直接读 Durable `pi.usage`，只用于观察，不设配额。**
5. **发生存储错误时进入失效态。** `Lifetime` 在首次持久层异常时标记失效，挂起中的调用与事件观察随即结束，由上层 Manager 队列关闭该 runtime 并在下一次恢复时重新打开。

## 持久化

`data/agents/<agentId>.sqlite`，启用 WAL 与 `synchronous=FULL`（经传入的 SQLite 适配器设置）。
