# Mate

Mate 是个人单 Slack workspace 中的持久 Agent 团队。每个 Agent 有跨频道/DM连续上下文、私有工作空间、持续预算以及可自主使用的沟通、消息任务、提醒和执行工具。模型决定关注什么、如何合作、是否发言和怎样组织知识。

运行层使用 **Pi Agent Core + pi-ai**；使用 **pnpm**；没有 pi-coding-agent、Jev或逐命令审批。当前能力、函数调用链和与Raft的差别见[HOW_IT_WORKS](docs/HOW_IT_WORKS.md)，设计依据见[项目定位](docs/PROJECT_DIRECTION.md)与[消息门控调研](docs/MESSAGE_GATING_RESEARCH.md)。

开发按[模块计划](docs/IMPLEMENTATION_PLAN.md)逐个实施、独立红队审核；记录在[reviews](docs/reviews/)，当前验证见[ACCEPTANCE](docs/ACCEPTANCE.md)，能力与证据关系见[CAPABILITY_MATRIX](docs/CAPABILITY_MATRIX.md)。只评harness，不评模型智能。

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

dataDir/state是数据库；dataDir/agents/AGENT_ID是私有持久workspace。MEMORY.md是恢复入口，知识内容和文件组织由Agent决定；notes/artifacts是起始目录。每run及压缩后刷新有界memory/checkpoint，提供截断和完整读取路径。

Linux容器部署必须配置`runtime.workspaceManifest`。manifest逐一声明私有workspace以及显式外部grant的mountpoint、ext4 backing file、硬容量和owner。daemon在创建MEMORY.md或连接Slack前核对：每个root是独立的ext4 loopback mount，backing file已实际分配而非稀疏占位，容量、设备、owner、`rw,nodev,nosuid`和loop identity全部匹配。缺失、共享设备或普通目录会直接终止；不会退回dataDir里的普通文件夹。`environment.info`会把已验证的硬容量随effective grant报告给Agent。

Ubuntu部署中，结构化文件操作和shell都经同一个Docker隔离后端；macOS本地开发的文件操作继续使用已验证的SRT，shell仍走Docker。应用不自动拉取镜像、不执行host shell、不把host credentials或Docker socket挂进Agent容器。Slack示例中的全零image只是必须替换的占位值。

runtime.docker字段：

- binary：Docker CLI绝对路径。
- host：unix:///…/docker.sock。
- image：sha256:后64位固定镜像ID。
- network：none（默认）或bridge（可路由局域网和互联网）。
- resources.memoryMb/cpus/pids/tmpfsMb：每次短生命周期容器的硬限制；默认512MiB、1 CPU、64进程和64MiB tmpfs。

固定镜像须包含`/usr/local/bin/node`、`/bin/sh`及需要的工具，并支持当前UID/GID访问`/workspace`。启动取得单实例锁后先清理本dataDir scope的遗留容器，再实际探测固定helper读写、helper侧越界拒绝、shell PID namespace清理；探针通过前不启动Slack adapter或模型run。任一操作只有在`docker rm --force --volumes`确认后才返回；清理结果不确定会熔断该backend，后续执行全部拒绝，直到显式startup/offline recover成功。create请求本身不确定时，`No such container`不足以解除不确定性。

私有root在配置Docker后获得exec。workspaceGrants指定agentId、绝对root和read/write/exec，可用可选的小写label帮助Agent选择；应用、DB和其他Agent私有目录不可作为共享grant。需要并行改同一项目时配置独立worktree。scope内直接执行，停止/取消由daemon和backend落实。environment.info按当前work报告仍有效的grant、相对路径规则、执行/网络、已知URL读取及输入输出adapter支持；它是会在每次动作时重验的快照，不是授权token。

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

先停止daemon。以下离线迁移是开发机或没有workspace manifest的unmanaged兼容路径，保留历史/任务/提醒/草稿/预算和私有文件：

```sh
pnpm node dist/src/main.js migrate mate.old.json mate.local.json /ABSOLUTE/upgrade-backup
# 只有升级旧库且确实没有配置快照时，明确声明所提供旧配置可信：
pnpm node dist/src/main.js migrate mate.old.json mate.local.json /ABSOLUTE/legacy-backup --accept-legacy-identity
```

只升级代码/prompt而配置未变时，可把同一配置文件作为OLD和NEW。新增Agent可迁移；已有Agent的Slack身份或workspace不能重绑/删除。迁移核对旧快照和runtime hash，持有内核锁，清理旧配置执行容器，fence旧run并备份，事务更新。被撤销/过期grant不会复活。没有历史身份快照时，legacy选项是owner声明，不能机器证明旧身份。带workspace manifest的managed部署会拒绝这条入口；它必须由后续部署事务先生成并root封存checkpoint，首版还要求Agent/mount topology不变。

```sh
pnpm node dist/src/main.js backup mate.local.json /ABSOLUTE/checkpoint
# managed checkpoint在backup子进程退出后由root封存：
sudo node dist/src/main.js checkpoint-seal mate.local.json /ABSOLUTE/checkpoint SERVICE_UID SERVICE_GID
# managed replace还要提供能证明当前live状态的已封存checkpoint：
pnpm node dist/src/main.js restore mate.local.json /ABSOLUTE/target-checkpoint --replace /ABSOLUTE/current-checkpoint
# unmanaged v2迁移备份和version 1兼容恢复都要求将旧dataDir整体移开、原dataDir不存在：
pnpm node dist/src/main.js restore mate.local.json /ABSOLUTE/checkpoint
```

备份目的目录必须未存在或是空的规范目录，并位于live dataDir之外；包含SQLite与私有文件，`COMPLETE.json`最后发布。managed部署的root wrapper应预建service-owned目录，并在成功后封存为`root:<service group> 0750/0640`；失败目录只能按预先记录的device/inode清理。恢复到原绝对dataDir。不要删库或删session来绕过升级检查。完整生产wrapper和systemd接线属于V2c/V2d，当前不要用unmanaged迁移替代它。

## 验证

```sh
pnpm run check
MATE_CONTAINER_TEST=1 MATE_DOCKER_BINARY=/usr/bin/docker \
MATE_DOCKER_HOST=unix:///var/run/docker.sock \
MATE_DOCKER_IMAGE=sha256:EXISTING_64_HEX_IMAGE_ID \
pnpm test tests/execution/sandbox.test.ts
```

普通集含真实Pi loop、Node worker/IPC与合成Slack/provider；Linux生产验收用container profile。SRT后端另用`MATE_SRT_TEST=1`，旧`MATE_SANDBOX_TEST=1`仅兼容需要同时运行两个profile的环境。V1b在本机Docker Linux VM中以固定Node 24 amd64 image跑过真实隔离测试；原生Linux宿主与systemd属于部署gate，不能由这项结果代替。真实Slack/provider待验的是scopes、事件、跨频道/DM接线、unknown对账、usage与错误协议，不要求证明模型会作出预设协作决策。详细故障与多选择证据见[验收表](docs/ACCEPTANCE.md)。
