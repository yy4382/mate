# 锁定依赖契约

2026-09-20；本地 Node 24.21.0，实际安装版本见 package-lock.json。

- `@earendil-works/pi-agent-core` 与 `pi-ai` 0.86.0：真实 Agent + 合成模型 stream。异步 `message_end` 阻塞工具启动；异步 `agent_end` 完成后才 idle；同一实例拒绝重叠 prompt。
- 持久订阅抛错后工具不执行；Agent 捕获错误并生成 error message，`prompt` 可以 resolve。后续 runtime 必须检查 `state.errorMessage`、最终 stopReason 和独立持久化失败标记。
- 持续存储故障也会阻止错误消息落盘：此时 `prompt` reject，但 `waitForIdle` resolve 且 `state.errorMessage` 可能为空。runtime 必须捕获 prompt rejection，不能仅看 idle/errorMessage。
- 初始 system/tool 声明存在 transcript 的 system message；恢复已有 system transcript 时新的 initialState.systemPrompt 不会静默覆盖它。配置更新必须显式迁移。
- TypeSafe 0.6.0 的入口为 `TypeSafeClient.systemOne`，模型显式固定 `jev-1.13.0`；官方 SDK 的自定义 fetch 用于离线 HTTP 契约，未调用真实 Jev。confidence 与选项 probabilities 分别读取。
- better-sqlite3 13.0.3 在项目 Node 24 ABI 下可用，事务 FK 失败回滚已验证。

运行：`PATH="$PWD/node_modules/.bin:$PATH" npm run check`。Node 从开发依赖隔离提供，也可使用 `.nvmrc` 指定版本。初次安装先 `npm install --ignore-scripts`，再 `npm rebuild node`，最后在上述 PATH 下 `npm rebuild better-sqlite3`。

此文档不声称 Slack、模型、Jev、沙箱或 worker 已集成。A 只验证其前置 SDK 契约，后续模块须独立验证。

一手依据：[Pi v0.86.0 Agent 源码](https://github.com/earendil-works/pi/blob/v0.86.0/packages/agent/src/agent.ts)、[TypeSafe JavaScript SDK](https://docs.typesafe.ai/sdk/javascript)；实现以锁定安装包的源码与类型为准。
