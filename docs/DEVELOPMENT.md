# 本地开发与验证

项目使用 `package.json` 指定的 Node 与 pnpm 版本。依赖、构建和测试以 `package.json`、`pnpm-lock.yaml` 为准；本文件只说明如何运行完整的本地入口。

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm typecheck
```

普通测试使用合成 Slack/provider 输入。涉及 Linux 用户执行、后台进程和部署的改动还应运行相应的定向测试：

```sh
pnpm exec vitest run tests/execution/linux-user.test.ts tests/execution/linux-processes.test.ts tests/deployment/linux-deployment.test.ts
```

macOS 本地入口不模拟 Linux 用户权限。普通测试、Debian 上以真实 UID/GID 验证文件与进程边界，以及真实 Slack/provider 连接是不同的证据；不能互相代替。当前发布待办与结论在 issue tracker 中，而非本文件。

`pnpm check` 在开发 checkout 运行；Linux 发布目标还需以目标 Node ABI 执行 `pnpm build`、`pnpm typecheck` 和 `MATE_NATIVE_UID_TEST=1 pnpm exec vitest run tests/execution/linux-user-tools.test.ts`。完整测试集包含使用非 Linux 本地开发夹具的用例，不能把这些夹具在生产 Linux 配置下的失败当作 Agent 隔离结果，也不能用它们代替原生验证。

## 本地双成员入口

复制 [mate.local.example.json](../mate.local.example.json) 为未提交的配置文件，把 `runtime.dataDir` 改为 checkout 外、当前用户可写的绝对目录。示例预配置 `research`、`writer` 和内部 `team-room`；本地入口不需要 Slack 身份。实际模型调用需要配置文件所引用的 provider 环境变量。

```sh
pnpm node dist/src/main.js check mate.local.json
pnpm node dist/src/main.js local mate.local.json
```

`local` 与 Slack 入口使用同一 daemon、会话、工具、消息门控和 owner 控制。它从标准输入逐行读取 JSON，请求的 `id` 对应响应的 `id`；日志写到 stderr。stdin 是可信宿主接口，不是可接受任意用户身份的网络 API。EOF 会关闭 console 和 daemon。

```json
{"id":"rooms","op":"rooms","human":"owner"}
{"id":"send","op":"send","human":"owner","eventId":"unique-request-1","target":{"conversationId":"team-room"},"text":"Investigate this question"}
{"id":"read","op":"read","human":"owner","target":{"conversationId":"team-room"}}
{"id":"status","op":"control","human":"owner","text":"status"}
```

`eventId` 是持久幂等键；同一身份与内容重试返回同一消息，改动内容会被拒绝。回复使用已返回规范消息 ID 作为 `target.threadId`。`read` 每页最多返回 100 条未删除消息，继续读取时将 `nextCursor` 作为 `before`。发送和读取检查当前房间成员资格，控制命令还检查 owner 权限。

本地房间成员资格由配置首次播种；重启不会恢复已撤销的访问。配置变更使用离线迁移。要检查恢复，在停止后以相同配置和 `dataDir` 重启，验证消息、session、任务、提醒、草稿、预算与 workspace 仍在。普通 assistant 文本是私有的；公开输出必须通过显式消息或成果工具，沉默也可以是有效选择。
