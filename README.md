# Mate

目标是让持续存在的Agent自主感知、选择工作、协作和管理自己的workspace。新的[项目定位](docs/PROJECT_DIRECTION.md)与[消息门控调研](docs/MESSAGE_GATING_RESEARCH.md)是产品基线。**下文描述现有原型；重新定位后的能力尚未实现，旧模块PASS不代表产品语义验收通过。**

个人单 Slack workspace 的持久多 Agent daemon。使用 **Pi Agent Core + pi-ai**，没有 pi-coding-agent。每 Agent 一个 Node worker、一个跨频道/DM 的逻辑 session 和独立 Markdown memory；SQLite 保存 inbox、任务、journal 和输出回执。

本地实现经过逐模块独立红队，记录在 [实施计划](docs/IMPLEMENTATION_PLAN.md) 和 [审核记录](docs/reviews/)。真实Slack/provider接线尚未凭证验收；脚本化模型测试用于验证harness机制，不评测模型智能。

## 本地启动

使用 pnpm 10.33.0。`pnpm-workspace.yaml`固定Node 24.21.0，并声明允许的原生依赖构建；不需要更改系统默认Node。设置依据[pnpm 10官方文档](https://github.com/pnpm/pnpm.io/blob/main/versioned_docs/version-10.x/settings.md)。

```sh
pnpm install --frozen-lockfile
pnpm run check
cp mate.example.json mate.local.json
pnpm node dist/src/main.js models anthropic
```

修改 `mate.local.json` 中的身份、频道、模型、绝对 dataDir；dataDir 必须在应用 checkout 外。示例模型来自已安装 Pi 的本地目录，未证明账户有调用权限。用终端环境/秘密管理器提供 `.env.example` 所列变量；程序不自动读取 `.env`。

```sh
pnpm node dist/src/main.js check mate.local.json
pnpm node dist/src/main.js start mate.local.json
```

`check` 仅检查本地配置、模型目录和变量存在，不连接外部服务。`start` 将连接真实 Slack 与配置的模型；首次先做下述小规模验收。日志写 stdout，不打印凭证或原始 Slack 内容。

## Slack 安装

每个 Agent 单独创建 Slack app，开启 Socket Mode，app-level token 授予 `connections:write`；bot token 配置 `app_mentions:read`、`chat:write`、`channels:read`、`channels:history`、`groups:read`、`groups:history`、`im:read`、`im:history`、`im:write`、`mpim:read`、`mpim:history`、`files:write`、`files:read`、`users:read`。按实际安装流程确认 `bots.info` 可用。订阅 `app_mention`、`message.channels`、`message.groups`、`message.im`、`member_joined_channel`、`member_left_channel`。将 bots 邀请到配置频道；私有频道不靠配置自动获得权限。

在其中一个 app 配置 `/team` slash command（`commands` scope）；Socket Mode 下无需公共 HTTP receiver。其他 apps 不重复注册同名命令。程序验证 auth.test 的 team/user/bot 及 bots.info 的 app_id。接收 envelope 先提交 SQLite 再 ack；Bolt 不负责业务事实源。

频道 `mentions` 仅 @mention、DM、已关注线程触发；`participate` 将普通消息按短时间窗口合并。Agent 的公开回复必须调用 `messages.send`，不会把模型私有文字自动发送。Peer 回声继承原 work 预算；发送结果未知时不盲目重试。启动/每五分钟补抓本地可见频道历史，最多 10 页；受 Slack scopes/限流影响的缺口记录为 `history_gap`。本地搜索只覆盖已接收/补抓内容，不能假装搜索了整个 workspace。

## 权限、memory 与工具

`dataDir/state/` 是中央数据库；`dataDir/agents/AGENT_ID/MEMORY.md`、`notes/`、`artifacts/` 属该 Agent。每次恢复经固定文件沙箱读取 MEMORY 入口，注入有界内容、全文 hash 和任务索引。超过 8KB 会明确提醒整理/读取全文，原文件不截断。文件写入有原子替换和最近五份版本。

结构化文件操作使用 SRT；当前实测平台是 macOS。任意 shell 必须配置本地 Docker 兼容引擎及**已存在的固定镜像 ID**；程序不拉取镜像、不开容器网络、不挂载主机 credentials/socket。镜像需要包含任务所需工具，并支持当前用户 UID/GID 写授权目录。macOS SRT 无法保证清理 setsid 子进程，因此没有退回主机 shell 的选项。

`runtime.docker` 示例字段：`binary` 为绝对 Docker CLI 路径，`host` 为 `unix:///…/docker.sock`，`image` 为 `sha256:` 后 64 位 digest。`workspaceGrants` 各项包含 `agentId`、绝对 `root`、`operations: ["read","write","exec"]`。配置是 owner 的持续授权；scope内exec直接执行，不逐条审查。重要目录和应用/DB 不可授权。不同 Agent 修改同一项目时请配置独立 worktree；全局 broker 会串行化副作用。

已删除Jev与命令审批代码、SDK、配置和控制入口。保留Broker的动作准备/执行边界及可注入ExecutionBackend；未来扩展方案见[调用链与feature现状](docs/HOW_IT_WORKS.md)。

`research.read` 仅允许 `researchHosts` 中的公共 HTTPS IPv4 域名，DNS 固定、重定向重新检查、无 cookies/凭证、限制响应大小和时间。它是读取已知 URL 的工具，不是全网搜索 API。`artifact.publish` 仅发布自己 `artifacts/` 下最多 64KB 的文本到显式 Slack target；未知上传不重试。二进制/大文件附件未支持。

配置身份/提示词版本改变时 session 要求显式迁移；运行权限配置改变也拒绝静默扩大旧 grant。备份后停机处理迁移，勿直接删除 session 或全库来规避检查。已撤销 grant 不自动重发。

## 管理与恢复

只有 `ownerUserIds` 可用 `/team` 控制：

- `status`、`tasks`、`schedules`
- `stop WORK_ID`、`resume WORK_ID`、`cancel WORK_ID`
- `agent-stop AGENT_ID`、`agent-resume AGENT_ID`
- `revoke GRANT_ID`
- `budget WORK_ID MAX_RUNS MAX_TOKENS MAX_USD`；增额后按需 resume

任务等待不会占住Agent处理其他频道的主run。停止立即中断worker，并终止容器执行；恢复不会补充预算。取消不可恢复。

未知模型 usage 保留整次预留，未知外部副作用不会自动重放。查看 status 中 unknown actions/outbox，再用真实 Slack 历史/本地文件核对；没有证据时保留 unknown。进程崩溃后内核释放文件锁，新实例先删除属于本 dataDir 的残留执行容器，再 fence旧 runs并恢复。Worker断开daemon即退出，固定文件helper通过IPC lifeline清理。

退出使用 SIGINT/SIGTERM，等待清理结束。离线备份命令要求 daemon 已停止；SQLite 用 backup API，不直接复制 WAL 主库。

```sh
pnpm node dist/src/main.js backup mate.local.json /ABSOLUTE/checkpoint-2026-09-20
# 恢复前把旧 dataDir 整体移开，原 dataDir 必须不存在；不会覆盖旧资料。
pnpm node dist/src/main.js restore mate.local.json /ABSOLUTE/checkpoint-2026-09-20
```

只有带 `COMPLETE.json` 的 checkpoint 可恢复，恢复到原绝对 dataDir，保留 DB 与 private memory 一致路径。备份包含私有信息，应保存在自己的受限目录。

## 验收边界

`pnpm run check` 编译并运行离线/合成集成测试，包括真实 Pi loop 与 Node worker。实际沙箱/容器测试需另开环境开关：

```sh
MATE_SANDBOX_TEST=1 MATE_DOCKER_HOST=unix:///ABSOLUTE/docker.sock \
MATE_DOCKER_IMAGE=sha256:EXISTING_64_HEX_IMAGE_ID \
pnpm test tests/execution/sandbox.test.ts
```

真实接线检查使用预定的合成动作：两个 bots 在两个频道及 DM 传递消息、委派/等待/读取结果；等待期间投递另一频道请求；kill/restart 后对账；owner stop 后确认没有晚到文件写入/重复消息。脚本化模型可验证这些机制；真实 provider 仅检查协议、token/cost 和错误兼容，Slack 检查权限、事件与 echo，不评测模型协作决策或成果质量。不得拿私有 Raft memory 当 fixture。开发过程没有推送、部署、创建外部资源或发送真实 Slack 消息。

架构函数调用链、已验证边界及原v1尚缺功能，详见[HOW_IT_WORKS](docs/HOW_IT_WORKS.md)。旧版本配置/数据库的限制和迁移说明也在该文档中。

R1a已加入频道/DM顶层消息（省略thread）、conversations.list/members/openDM。Directory用当前bot凭证发现已加入空间；列表分页最多10页并报告incomplete。v8首次升级会在数据库旁保存600权限的pre-v8一致备份；旧thread请求与hash保留。实际Slack接线仍待凭证验证。

R1b预算模型：配置budget为每Agent持久累计账户的初始上限，消息不会重置。`/team agent-budget AGENT_ID MAX_RUNS MAX_TOKENS MAX_USD`由owner修改上限；原`budget WORK_ID ...`仍是额外事项上限。`works.list/select`允许运行中切换可见事项，`budget.read`展示自身账户。一次run计入起始事项及Agent账户；动作/停止使用单独的当前事项。v9升级先备份，历史共享work使用量无法精确分摊，保守计入各参与Agent并审计，可能需owner显式提高额度。账户耗尽不会自动补额或设置Agent暂停；旧session配置变更迁移仍待R7。

文件发布对账需要 `files:read`（files.info）；已有Slack安装增加scope后需要重新安装/授权应用。文件上传和发布分阶段保存，只有已开始分享的未知结果才进入待对账；不自动重发。

工具环境支持 `tools.list` / `tools.describe` 按需发现，`environment.info` 返回配置的镜像、网络和研究站点。工具链由固定digest镜像提供，Agent可在`/workspace`运行脚本、检查版本和安装workspace内依赖；镜像不会自动拉取。`runtime.docker.network`默认为`none`，owner可显式配置`bridge`。bridge会开放容器到外部以及可路由本地网络的访问，不是仅限公网的过滤器；不挂载host凭证或Docker socket，不发布端口。独立审核席位强制`none`。参见[Docker网络说明](https://docs.docker.com/engine/network/)。

`attachments.save`只接受当前可见消息中的fileId，通过当前Agent的Slack身份下载到granted workspace；不接受模型提供的URL或token，不跟随认证重定向，单文件最多1MB。`file.read_bytes/write_bytes`支持二进制处理，`artifact.publish format=binary`冻结最多1MB文件后走同一发布门控；文本模式仍为64KiB。草稿仅返回哈希、大小、文件名等元数据，避免把大型base64塞入模型上下文。Slack历史cache的同版本消息可补齐过去丢弃的文件metadata；已呈现的publication与后到的相同caption/fileId echo合并为一次未读。参见[Slack文件认证](https://docs.slack.dev/reference/objects/file-object/)。
