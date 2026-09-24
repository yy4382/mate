# Mate

Mate 为一个个人 Slack 工作区提供持续工作的 Agent 团队。每个 Agent 在频道和私信（DM）之间延续同一段工作上下文，拥有私人目录、持续预算，以及可自主使用的沟通、任务、提醒和执行工具。模型决定关注什么、如何合作、是否发言和怎样组织知识。

运行层使用 **Pi Agent Core + pi-ai**；使用 **pnpm**；没有 pi-coding-agent 或 Jev。普通 Agent 命令不逐条审批；需要管理员权限的系统级命令（例如安装系统软件或管理服务）须由用户逐条同意。[当前实现状态](docs/HOW_IT_WORKS.md)、[项目方向](docs/PROJECT_DIRECTION.md)与[消息门控调研](docs/MESSAGE_GATING_RESEARCH.md)分别说明现状、目标和相关设计依据。

开发按 GitHub Issues 中的当前规格与票据推进；[首版目标](docs/IMPLEMENTATION_PLAN.md)和[验收边界](docs/ACCEPTANCE.md)说明交付范围。验收检查工具和运行环境能否支持 Agent 的选择，不评判模型是否足够聪明或主动。

Debian 13 首版部署为每位 Agent 创建独立的 Linux 用户账号，用该账号运行普通命令。Mate 的数据库和凭证只有系统管理员账号 root 可读；系统级命令须先由配置中的真人用户在 Slack 中逐条确认。安装步骤与系统资源限额见[部署说明](docs/DEPLOYMENT.md)。缺少凭证时，安装不会自动启动主服务。

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

`check` 只做本地校验；`local` 通过每行一个 JSON 请求提供本地人类入口，`start` 连接配置的 Slack 和模型服务。退出用 SIGINT/SIGTERM，等待执行清理。日志不打印凭证或原始 Slack 正文。完整本地请求示例和真实 Slack 逐项验收见[实验运行手册](docs/EXPERIMENT_RUNBOOK.md)。

## Slack配置

每Agent一个app，Socket Mode的app token授予connections:write。Bot scopes：app_mentions:read、chat:write、channels:read、channels:history、channels:join、channels:manage、groups:read、groups:history、groups:write、im:read、im:history、im:write、mpim:read、mpim:history、mpim:write、files:read、files:write、users:read。订阅app_mention、message.channels/groups/im、member_joined_channel/member_left_channel。邀请bot到相应频道；私有频道权限不由配置自动授予。首板使用预配置成员，不会自动创建Slack app。

其中一个app注册/team（commands scope），无需公共HTTP receiver。启动验证team/user/bot/app identity。正式使用前应验证当前安装的scopes、事件和bot echo；开发未连接真实Slack或发送消息。

mentions模式由@mention、DM或watch触发；participate对普通消息合并notice。模型按需attention.read，结束run不清未读。可发送频道顶层、thread或DM；conversations.list/members/openDM提供发现和主动联系。普通assistant输出保持私有，公开输出必须显式调用工具。

消息/任务/附件提交会检查已呈现的讨论依据，必要时保存held draft/intent。模型可重读重试、修改、丢弃、暂缓或知情继续；不做观点裁决。发送前重查本地状态，unknown不重发。Slack不提供整个房间版本的原子发送保证。

## Workspace与执行环境

`dataDir/state` 存放 Mate 的数据库，Agent 不能读取。每位 Agent 都有自己的 Linux 用户账号和私人目录；`runtime.linuxUsers` 指定账号编号与目录位置。`MEMORY.md` 是 Agent 恢复工作时首先读取的文件，`notes/artifacts` 是初始目录，之后由 Agent 自行组织文件。`runtime.sharedRoot` 指定同伴默认可读的共享目录，每位 Agent 只能修改自己的共享子目录。文件工具和普通命令都以该 Agent 的账号运行，看到相同的路径和文件权限；Mate 不把自身凭证交给 Agent。Agent 启动的长任务可在一次工具调用结束后继续运行，Agent 与用户可以查看和停止它，并受该账号的系统资源限额约束。

`research.read` 只能读取 Agent 已知网址且配置允许的公共 HTTPS 页面，不能搜索网页。`attachments.save` 可将 Agent 有权查看的 Slack 附件保存到它能写入的目录。`artifact.publish/revise` 用于发布或修改 Agent 的成果文件；文本发布上限为 64 KiB，二进制文件和下载上限为 1 MiB。

低配机器默认通过`runtime.limits`限制进程内资源：`maxActiveRuns:1`让所有Agent公平排队执行run，`maxBackendOperations:1`限制同时进行的文件/命令操作，`workerIdleMs:300000`在空闲五分钟后释放模型worker。停止Agent或关闭daemon会撤销尚未取得槽位的等待；执行失败也会释放槽位。消息、任务、提醒和上下文仍保存在SQLite中，进程内队列不承担持久化职责。`check`会回显最终生效的限制。

## 管理、预算与上下文

只有ownerUserIds可用/team：

- status、activity [JSON]、tasks、schedules（均为安全结构化视图；activity可分页/过滤）
- stop|resume|cancel WORK_ID
- agent-stop|agent-resume AGENT_ID
- agent-reset AGENT_ID CHECKPOINT：保留持久身份/工作，更换上下文后保持paused
- agent-budget AGENT_ID MAX_RUNS MAX_TOKENS MAX_USD
- budget WORK_ID MAX_RUNS MAX_TOKENS MAX_USD
- review-seat AGENT_ID {"target":{"channel":"…"},"brief":"…"}；review-release AGENT_ID

普通同伴评审无需 `review-seat`。`review-seat` 用于用户指定一名未参与该项工作的 Agent 做独立盲审。Mate 给它审查任务说明和干净的私人目录，不把已有对话与同伴结论放进审查输入；审查发言先留待确认。它仍以自己的 Linux 用户账号使用普通文件、命令和网络，因此不能承诺彻底隔绝它主动从其他可访问来源获取信息。`review-release` 结束盲审并停止该 Agent，随后如需继续工作可 `agent-resume`。

每位 Agent 的预算是持续累计的；新消息、切换工作事项、重置上下文或修改配置都不会自动增加预算。配置中的预算只在首次创建 Agent 时使用；用户提高累计上限后可恢复 Agent。若一次操作是否执行成功无法确认，Mate 不会擅自重试；Agent 可用 `actions.list/read` 查看已记录的执行结果。

## 显式升级与备份

先停止主服务和 Agent 后台任务。`matectl backup NAME` 保存数据库与私人目录；`matectl restore TARGET --replace CURRENT` 先验证当前状态的备份，再恢复目标数据和目录归属。共享工作目录另按普通 VPS 文件备份方式处理。代码升级用 `matectl upgrade SPEC`、`rollback`、`finalize`，不改数据；配置变更用明确的离线迁移，不自动更换现有 Agent 的 Linux 账号或私人目录位置。详见[运维手册](docs/OPERATIONS_RUNBOOK.md)。

## 验证

`pnpm check`、`pnpm typecheck` 和集成测试检查本地逻辑，并在测试中模拟 Slack 与模型服务。还须在 Debian 13 上用两个真实的 Linux 用户账号检查私人/共享文件权限，以及长任务的查看和停止。真实 Slack、模型服务和目标 VPS 的连接另行验收；本地测试通过不能代替这些检查。详见[验收边界](docs/ACCEPTANCE.md)。
