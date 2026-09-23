# 实验版运行与真实接线清单

本手册把可重复的本地 harness 实验与尚需账号的真实 Slack/provider 验收分开。实验只判断一个足够智能的模型在给定工具、环境和 prompt 下能否选择并完成行为，不评模型会不会按固定剧本表演。

## 本地双成员实验

复制 `mate.local.example.json`，把 `runtime.dataDir` 改为 checkout 外、当前用户可写的绝对目录。示例预配置 `research`、`writer` 和内部 `team-room`；Agent 定义不含 Slack 身份，local adapter 也不走 Slack SDK。提供 `MODEL_API_KEY` 后运行：

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm node dist/src/main.js check mate.local.json
pnpm node dist/src/main.js local mate.local.json
```

`local` 从标准输入逐行接收 JSON，并从标准输出逐行返回 JSON。每个请求的 `id` 用于调用方配对；`eventId` 是输入幂等键，同 ID 改参数会拒绝。

```json
{"id":"rooms-1","op":"rooms","human":"owner"}
{"id":"send-1","op":"send","human":"owner","eventId":"experiment-1","target":{"conversationId":"team-room"},"text":"请调查这个问题；自行决定是否需要认领、联系同伴、延后或保持沉默。"}
{"id":"read-1","op":"read","human":"owner","target":{"conversationId":"team-room"}}
{"id":"status-1","op":"control","human":"owner","text":"status"}
{"id":"activity-1","op":"control","human":"owner","text":"activity {}"}
```

公开发言只来自 `messages.send` 或成果发布；普通 assistant 文本保持私有。没有输出也可能是有效的沉默选择。检查任务、草稿、提醒、run 和 action 时以 `status`/`activity` 及对应工具的持久状态为准，不从一句自然语言回复反推内部状态。停止进程后重新运行同一配置和 dataDir，应保留消息、session、任务、提醒、草稿、预算和 workspace。

## 真实 Slack 接线

复制 `mate.example.json`，为每个预配置 Agent 手动创建一个 Slack app，然后填写 workspace、owner、app/user/bot/channel ID。Agent 定义与 `adapters.slack.bindings` 分开；不要把 token 写进 JSON。用环境变量提供每个 app 的 bot token、Socket Mode app token及 provider key。

每个 app 开启 Socket Mode，app token scope 为 `connections:write`。Bot scopes：`app_mentions:read`、`chat:write`、`channels:read`、`channels:history`、`channels:join`、`channels:manage`、`groups:read`、`groups:history`、`groups:write`、`im:read`、`im:history`、`im:write`、`mpim:read`、`mpim:history`、`mpim:write`、`files:read`、`files:write`、`users:read`。其中 `channels:join` 支持加入公开频道，`channels:manage`/`groups:write` 支持从相应频道离开。订阅 `app_mention`、`message.channels`、`message.groups`、`message.im`、`member_joined_channel`、`member_left_channel`。其中一个 app 再注册 `/team` 并获得 `commands` scope。把各 bot 邀请到相应频道；私有频道仍只能被邀请加入，配置不会替 Slack 授权。

启动前把示例中的全零Docker image替换成目标机已存在镜像的完整`sha256:` image ID；镜像须含`/usr/local/bin/node`与`/bin/sh`。Linux部署还必须由部署层按`runtime.workspaceManifest`预先建立每Agent独立的预分配ext4 loopback mount；配置了外部workspace grant时也必须在manifest中逐一声明其独立容量边界。运行 `check`。报告中的 `checkScope:configuration_model_and_secret_references` 与 `externalConnectivityChecked:false` 明确表示它只验证配置、模型目录、manifest路径字段和所需环境变量引用，并列出程序功能需要的 bot scopes；它不检查mount、dataDir可写性、镜像存在、token授权、安装身份或网络。`start`会先清理本scope，再核对manifest的mount identity、容量、owner和预分配证据，然后运行容器读写、越界和PID namespace探针；任何失败都在连接Slack前退出。随后启动 daemon：

```sh
pnpm node dist/src/main.js check mate.production.json
pnpm node dist/src/main.js start mate.production.json
```

第一次真实接线按下面顺序验收，并记录实际目标与回执：

1. 启动身份核对成功，两个 app 都接入同一 workspace；错误 app/user/bot/team ID 必须使启动失败。
2. 在 mentions 频道分别 mention 两个 Agent，确认事件只投递给当前可见成员；再验证一个顶层回复、一个 thread 回复和一个人类 DM。
3. 让一个 Agent 用 `conversations.openDM` 联系同伴，确认内部 Agent DM 无需借 Slack bot 互相私聊；外部可见输出仍只去显式 target。
4. 上传一个小文件，验证 metadata、认证下载、文件读取和成果发布；分享目标不支持时应在冻结前拒绝。
5. 在草稿 held 后新增一条消息，验证补读重试、修改、放弃、暂缓和知情继续至少各有一条可达路径。这里只验证 harness 路径，不要求真实模型自动选中指定分支。
6. 用 `/team status`、`activity {}`、`agent-stop`/`agent-resume` 检查 owner 控制；非 owner 必须被拒绝。
7. 人为制造一次 429 和一次发送后回执丢失，核对 retry/unknown 不会盲目重发；重启后状态保持。
8. 核对 provider usage、错误格式、取消和超时。模型回复质量不属于这个协议验收。

在上述真实检查完成前，仓库只能声明合成 Slack/provider 协议通过。Mate 不会自动创建 Slack app、频道或外部资源，也不会发送测试消息来替代人工接线。
