# Mate

Mate 是个人单 Slack workspace 中的持久 Agent 团队。每个 Agent 有跨频道/DM连续上下文、私有工作空间、持续预算以及可自主使用的沟通、消息任务、提醒和执行工具。模型决定关注什么、如何合作、是否发言和怎样组织知识。

运行层使用 **Pi Agent Core + pi-ai**；使用 **pnpm**；没有 pi-coding-agent 或 Jev。普通 Agent 命令不逐条审批，系统级命令需要用户逐条同意。[当前实现状态](docs/HOW_IT_WORKS.md)、[项目方向](docs/PROJECT_DIRECTION.md)与[消息门控调研](docs/MESSAGE_GATING_RESEARCH.md)分别说明现状、目标和相关设计依据。

开发按 GitHub Issues 中的当前规格与票据推进；[首版目标](docs/IMPLEMENTATION_PLAN.md)和[验收边界](docs/ACCEPTANCE.md)说明交付范围。只评 harness，不评模型智能。

Debian 13 首版部署以每 Agent 独立 Linux 用户运行普通命令，Mate 的状态和凭证保持 root-only；系统级命令逐条经 Slack owner 确认。安装使用 plan/preflight/install、systemd slices 和 `matectl`；完整流程见[部署说明](docs/DEPLOYMENT.md)。安装不会因缺少 secret 自动启动主服务。

## 本地运行

pnpm 10.33.0；workspace配置固定Node 24.21.0和原生依赖构建。

```sh
pnpm install --frozen-lockfile
pnpm run check
cp mate.local.example.json mate.local.json
pnpm node dist/src/main.js models anthropic
```

本地示例预配置两个成员和一个内部房间；修改模型和绝对dataDir。Slack示例是[mate.example.json](mate.example.json)，其中Agent身份与平台binding分开。dataDir必须在应用checkout外。通过终端环境/秘密管理器提供[.env.example](.env.example)中的变量；程序不自动读.env。模型目录只证明Pi识别该model，不证明账户可调用。

```sh
pnpm node dist/src/main.js check mate.local.json
pnpm node dist/src/main.js local mate.local.json
```

check只做本地校验；local通过JSONL提供本地人类入口，start连接配置的Slack及provider。退出用SIGINT/SIGTERM，等待执行清理。日志不打印凭证或原始Slack正文。完整本地请求示例和真实Slack逐项验收见[实验运行手册](docs/EXPERIMENT_RUNBOOK.md)。

## Slack配置

每Agent一个app，Socket Mode的app token授予connections:write。Bot scopes：app_mentions:read、chat:write、channels:read、channels:history、channels:join、channels:manage、groups:read、groups:history、groups:write、im:read、im:history、im:write、mpim:read、mpim:history、mpim:write、files:read、files:write、users:read。订阅app_mention、message.channels/groups/im、member_joined_channel/member_left_channel。邀请bot到相应频道；私有频道权限不由配置自动授予。首板使用预配置成员，不会自动创建Slack app。

其中一个app注册/team（commands scope），无需公共HTTP receiver。启动验证team/user/bot/app identity。正式使用前应验证当前安装的scopes、事件和bot echo；开发未连接真实Slack或发送消息。

mentions模式由@mention、DM或watch触发；participate对普通消息合并notice。模型按需attention.read，结束run不清未读。可发送频道顶层、thread或DM；conversations.list/members/openDM提供发现和主动联系。普通assistant输出保持私有，公开输出必须显式调用工具。

消息/任务/附件提交会检查已呈现的讨论依据，必要时保存held draft/intent。模型可重读重试、修改、丢弃、暂缓或知情继续；不做观点裁决。发送前重查本地状态，unknown不重发。Slack不提供整个房间版本的原子发送保证。

## Workspace与执行环境

`dataDir/state` 是 Mate 的 root-only 数据库；每位 Agent 的私人 home 由 `runtime.linuxUsers` 指定，`MEMORY.md` 是恢复入口，`notes/artifacts` 是起始目录，内容组织由 Agent 自己决定。`runtime.sharedRoot` 是同伴默认可读的普通 VPS 目录，各 Agent 对自己的共享子目录有写权限。命令和结构化文件操作使用同一 Agent UID/GID，正常网络和宿主文件布局可用；Mate 不把自己的凭证或控制身份交给 Agent。Agent 长任务在 systemd scope 中继续运行，可列出、停止并受 slice 配额约束。

`workspaceGrants` 仍可授予额外项目目录的 read/write/exec 能力，但不会改变 Linux 文件权限。`environment.info` 报告当前工作环境和有效 grant；它是可重验的能力快照，不是权限令牌。

research.read是allowlist已知公共HTTPS URL读取，不是搜索。attachments.save接可见Slack消息中的fileId，保存到授权目录；artifact.publish/revise发布自身artifacts文件并经过同一门控。文本发布上限64KiB，binary/下载1MB。完整工具限制见[调用链说明](docs/HOW_IT_WORKS.md)。

低配机器默认通过`runtime.limits`限制进程内资源：`maxActiveRuns:1`让所有Agent公平排队执行run，`maxBackendOperations:1`限制同时进行的文件/命令操作，`workerIdleMs:300000`在空闲五分钟后释放模型worker。停止Agent或关闭daemon会撤销尚未取得槽位的等待；执行失败也会释放槽位。消息、任务、提醒和上下文仍保存在SQLite中，进程内队列不承担持久化职责。`check`会回显最终生效的限制。

## 管理、预算与上下文

只有ownerUserIds可用/team：

- status、activity [JSON]、tasks、schedules（均为安全结构化视图；activity可分页/过滤）
- stop|resume|cancel WORK_ID
- agent-stop|agent-resume AGENT_ID
- agent-reset AGENT_ID CHECKPOINT：保留持久身份/工作，更换上下文后保持paused
- agent-budget AGENT_ID MAX_RUNS MAX_TOKENS MAX_USD
- budget WORK_ID MAX_RUNS MAX_TOKENS MAX_USD
- revoke GRANT_ID
- review-seat AGENT_ID {"target":{"channel":"…"},"brief":"…"}；review-release AGENT_ID

review seat要求从未运行的身份和干净workspace，隔离对话/peer信息与网络。release停止Agent，随后需resume。

Agent账户是持续累计额度；新消息、work、reset、配置迁移不补额。配置budgets只首次初始化；owner调整累计上限后按需resume。未知usage保留预留，unknown副作用不盲目重放。模型可通过actions.list/read检查自身执行回执；非执行对象使用各自当前ACL读取工具。

## 显式升级与备份

先停止主服务和 Agent 后台任务。`matectl backup NAME` 保存 SQLite 与私人 home；`matectl restore TARGET --replace CURRENT` 先验证当前状态的 checkpoint，再恢复目标数据及 Agent UID/GID。共享工作目录另按普通 VPS 文件备份方式处理。代码升级用 `matectl upgrade SPEC`、`rollback`、`finalize`，不改数据；配置变更用明确的离线迁移，并保持现有 Linux UID/GID/home 稳定。详见[运维手册](docs/OPERATIONS_RUNBOOK.md)。

## 验证

`pnpm check`、`pnpm typecheck` 和针对性集成测试覆盖本地逻辑与合成 Slack/provider 流程。Debian 13 上还须做两 Agent UID/文件权限/后台任务的小型原生 smoke；真实 Slack/provider 接线、usage 和错误协议另行验收。本地通过不能冒充 VPS 或外部服务已验证。详见[验收边界](docs/ACCEPTANCE.md)。
