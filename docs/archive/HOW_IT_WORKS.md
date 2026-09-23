> 本文解释当前代码路径，不管理待办。历史阶段与债务记录见[归档计划](IMPLEMENTATION_PLAN-2026-09-21.md)；架构见[ARCHITECTURE](ARCHITECTURE.md)。

# Mate 当前调用链、能力与边界

2026-09-20，旧阶段已逐模块通过独立红队，历史验收见 [ACCEPTANCE](ACCEPTANCE.md)。本文件描述代码；[PROJECT_DIRECTION](../PROJECT_DIRECTION.md)解释产品方向，[归档计划](IMPLEMENTATION_PLAN-2026-09-21.md)与[审核记录](../reviews/)保留各 gate 的证据。

验收只问：假设模型足够智能，工具、环境、prompt 和状态机是否允许它实现目标，并在并发、重启、失败时保持契约。脚本化模型用于选择分支，不是模型性能评测。

## 从输入到模型，再到工具

```mermaid
flowchart TD
  Slack[Slack Socket Mode] --> Receive[DurableReceiver.receive]
  Receive --> Persist[Store.ingest: commit before ACK]
  Persist --> Replay[SlackService.replay / Ingress.replay]
  Replay --> Messages[Messages.normalize / record]
  Messages --> Events[消息缓存 / revision / audience]
  Messages --> Inbox[持久 delivery + work binding]
  Inbox --> Run[Daemon.loop → Supervisor.step]
  Run --> Budget[beginRun → reserve Agent及事项预算]
  Budget --> Restore[恢复当前session / memory / checkpoint]
  Restore --> Worker[WorkerClient → serveWorker → Engine]
  Worker --> Pi[Pi Agent.continue]
  Pi --> Journal[message_end → IPC → journal ACK]
  Journal --> Tool[ToolRouter.call → policy executor → ToolModule]
  Tool --> Pi
  Pi --> Finish[结算 / finish / snapshot / continuation]
```

入口：[main](../../src/main.ts)、[Daemon](../../src/daemon/app.ts)、[Supervisor](../../src/runtime/supervisor.ts)、[Engine](../../src/runtime/engine.ts)。Pi Core + pi-ai 是实际运行层，没有 pi-coding-agent。

同一 Agent 的频道、thread、DM 输入使用同一个当前 session 和 worker；不同 Agent 分开。SQLite 保存原始 journal、恢复 snapshot、队列和回执。每 Agent 同时只有一个主 run；普通输入排队，同时 content-free notice 在下一模型调用边界注入当前 run，不强杀正在执行的工具。owner stop 则走独立 abort/fence 路径。

Notice、读取、处理彼此独立。消息到达或进入 inbox 不等于正文已呈现；finish 不等于解决未读问题。模型通过 attention.read 按需获取正文，通过 defer/resolve/mute/watch 管理注意力。

历史读取也不等于处理。`history.page/search/around` 在当前 ACL 下查询本地 canonical 缓存；`history.fetch` 通过行动 Agent 自己的 installation 有界补一页外部历史。回填只补正文/revision/visibility并使旧 freshness view 在必要时失效，不写 observation、delivery、seen 或 resolved。每次结果明确给出 scope、continuation 和 gap；详见 [HISTORY](HISTORY.md)。

Slack adapter 启动时先记录接收责任水位并连接各 App 的 Socket，再发现频道/DM、核对 membership、分页补齐离线消息与投影回复。它还扫描频道旧 root 的 `latest_reply`，发现停机期间在未 watch 的旧 thread 中首次出现的回复；旧 root 只作为历史导入，不产生新的工作通知。每页进度保存在 SQLite，失败后可以继续。启动会完整扫描；运行期间按页预算继续未完扫描，正常情况下每小时重新检查旧线程，Socket 断线后立即安排下一轮检查。Agent 主动发起的目录查询仍有分页上限，启动恢复会遍历完整目录。

Slack history/replies 无法重建停机或 Socket 断线期间删除的消息，也不能保证取得旧消息的每次编辑。重启或断线时 adapter 使先前的 view token 和已接受讨论版本失效，并在新读取的 `coverage.gaps` 中标记 `slack_offline_edits_and_deletes_not_reconstructible`；频道缺口也覆盖之后才发现的旧 thread。本地缓存可能仍有旧版本；这个标记告知 Agent 需要自行判断是否进一步核实，不能被解释成缺失的编辑或删除已经恢复。

## 可见性、事项、任务和预算不是同一个对象

| 对象 | 用途 | 不会自动发生的事 |
|---|---|---|
| Agent / current session | 持久身份和当前上下文 | 换 session 不创建新身份、不清预算 |
| Target | channel、可选 thread；DM也是channel ID | 不是独立Agent上下文 |
| Work | 动作控制、事项额度、run归属 | 不是所有读取操作的ACL，也不是必须采用的任务树 |
| Canonical task | 原消息上的所有权、版本和状态 | 不因重复create生成同一消息的第二个owner |
| Agent budget account | 持续 runs/tokens/cost，预留与结算 | 新人类消息、peer消息、work或reset不补额 |
| Grant | 特定Agent/事项/root的read/write/exec授权 | 消息或memory文本不能扩大权限 |

[BudgetLedger](../../src/budget/ledger.ts)先预留、后按可信 usage 结算；未知 usage 保留预留债务。一次 run 的模型费归起始事项和Agent；works.select 切换后续动作与控制归属，并获取新事项 grants，不改写既有账单。事项耗尽不会暂停整个Agent，其他事项仍可调度；Agent账户耗尽需要owner提高累计上限。配置预算只首次播种账户。

读取按当前可见性；跨事项任务读取和同伴讨论可达。曾读过的私有频道内容仍可能保留在这个Agent的共同上下文中；撤销ACL防止新工具读取，并不使模型忘记旧内容。

## 消息门控如何保留自主判断

旧 Attention 实现维护本地 observed revision、分页快照和 viewToken。新增、编辑、删除、晚到消息、可见性变化都形成事件。完整 toolResult 随 journal 提交后才ACK呈现；搜索、metadata、半页、未ACK结果不能充当完整视图。token绑定Agent/session/epoch/target/revision，压缩和session更换后失效。

```text
attention.read → 完整呈现ACK → viewToken
messages.send / artifact.publish / task mutation
  ├─依据仍有效 → queued / 接受任务变更
  └─依据缺失或过时 → held draft / task intent，无提交副作用
       ├─读取后 retry（再次检查）
       ├─revise（新不可变版本）
       ├─discard / 保留、暂缓
       └─continue（当前hold+revision，有限知情继续）
```

旧 FreshnessGate 实现不评价内容质量，不审查命令。continue只跨越freshness，不跨ACL、task CAS、停止或unknown。消息continue绑定60秒内一次派发机会，超时重新hold，不成为永久“忽略变化”。

旧 Output.ready/sendNow 路径在真正派发前再检查：owner/Agent/work状态、当前ACL、相关未规范化ingress、unknown/sending阻挡和freshness。429后重查；网络丢回执转unknown，不自动重发。阻挡条件在LIMIT前过滤，避免一个频道饿死其他频道。派发当时全局串行，强于按目标串行，吞吐量相应受限。

Slack没有这里所需的“比较整个房间版本后原子发送”事务。保证覆盖本地已观察状态；外部消息可在本地检查之后到达。完整调研与来源见[MESSAGE_GATING_RESEARCH](MESSAGE_GATING_RESEARCH.md)。

## 直接协作、消息任务和提醒

直接路径：A messages.send @B → gate/outbox → confirmed → Messages.record → B持久delivery → B下一run。无需总管、父任务或委派树；自己的echo去重。同伴可以选择回复、核实、补充、暂缓或沉默。

需要追踪所有权时，[MessageTasks](../../src/coordination/messages.ts)的 tasks.claim 接原始messageRef或既有taskId，唯一message_key加version CAS。所有按taskId的读取和变更都先经过[TaskBoard](../../src/coordination/board.ts)的同一可见性判断；external message-task必须有行动Agent自己的installation snapshot，不能只凭频道ACL或猜到ID读取/变更。hold时不提前占有任务；继续也不能抢占另一个owner。unclaim/transfer/update都有版本约束。tasks.create先发可见消息，confirmed后才激活任务；未发布或发布失败的task只向creator、assignee或owner开放。历史无法证明原始消息来源且没有message binding的旧task才标legacy，不猜测合并。

`TaskTransitions`把状态、owner、assignee、等待依赖、message/outbox binding和对应event作为同一事务提交；自动dependency wake、delegation发布/失败、draft revision和work cancel也走同一边界。v22迁移只按唯一create actor、draft outbox actor、assigned actor依次回填createdBy；无法证明时保持unknown，并为旧event写明从哪个version之后才完整。

tasks.list按owned、assigned、available、all-visible分页；cursor绑定actor和查询。每次最多扫描200个候选，即使某页因当前ACL/snapshot全部不可见，也返回scan continuation而不在低配VPS上扫完整表。tasks.events另行分页并返回历史coverage。普通peer review的review状态在claim/unclaim时保留；transfer明确选择继续review或退回doing。独立blind review仍走review seat。tasks.wait建立持久依赖并释放run，等待者仍能处理其他对话。新任务与状态投影是可见信息，不代替Agent自己的讨论判断。

[Reminders](../../src/reminders/service.ts)由作者管理content、target、可选anchor/task、时间、cron、version和日志。完成task不取消提醒；事项pause/cancel仍控制其触发。默认`private`只原子写author delivery与firing，不产生outbox、conversation event或peer attention；显式`conversation_receipt`才生成无正文的固定回执。delivery携带firingId；Agent处理后用reminders.finish幂等记录completed、failed或deferred，summary保持作者私有。deferred只描述本次结果，不自动安排下一次唤醒。log分别分页scheduler events与firings，并分开展示delivery、run、receipt和语义result。cancel默认取消未来，显式cancelPending可撤回尚未被run选中的队列，已选中/注入单独报告。

## Owner状态与activity

[OperationsView](../../src/operations/view.ts)是local控制入口、Slack `/team`和未来网页共用的owner-only应用服务，认证在service内部完成。`status`直接查询Agent暂停/active run、账户预算、works、unknown action/output、held draft和due reminder的权威状态；DTO只含ID、状态、计数、额度和安全引用，不返回action/outbox request、receipt、run error、task/reminder/result正文、路径或模型输出。`tasks`和`schedules`控制命令也改为相应安全activity视图，不再直接暴露数据库行。

`activity`按时间稳定合并task event、reminder event/firing以及run/action/outbox的安全状态投影。查询可按source、actor和kind过滤；opaque cursor绑定完整查询并分别保存各source的位置，返回每个source的continuation和coverage。旧action/outbox没有可信时间，因此v23保持`created_at=NULL`并报告gap，不用迁移时刻伪造历史。task和reminder的旧记录也沿用各自baseline/legacy coverage。

只有缺少已有事件来源的internal DM创建元数据和run完成/失败/中断写入`operational_facts`。fact不存DM正文、参与者列表、工具参数、receipt、错误、私有memory或模型输出；唯一source key支持幂等，写入失败会回滚同事务中的DM或run状态变化。读取status/activity不写event、delivery、outbox或attention，也不唤醒Agent。未来投影到保留频道时仍需adapter选择category和公开级别；核心不会自行创建或发送该频道。

## 工具与执行的实际路径

`ToolRouter`只处理发现别名、严格解析、seat/work策略、动作重放和await后的run/abort/ACL/work fence。82个内建operation由conversation-history、coordination-reminders、session-status和capabilities四个静态`ToolModule`组合；每个spec必须同时注册schema、说明、work/seat/effect/replay策略、参数授权器、fence和handler。缺字段、未知策略、重复名字、保留`tools.*`或不相容的effect/replay/seat组合会在启动时失败。生产Router只装配这组经审核的静态模块，不接受运行时module注入；未来增加平台或CLI能力时应通过同一完整spec组合并重新发布，而不是在路由switch或adapter里另开授权旁路。

`atomic-recorded`本地操作把原operation+args、领域写入和settle放在一个SQLite事务；immutable重放返回旧回执，refreshable读取重查当前状态，executing/unknown不重放。为兼容重构前已经落盘的回执，action identity仍保留调用时所选work；task/reminder（包括held intent）workPolicy另行把授权和实际领域写入绑定到对象所属work。broker/adapter边界已有自己的receipt，不再由Router套第二份action。direct调用与`tools.call`、list、describe使用同一spec和seat策略。name、description、输入JSON schema及四类策略形成稳定contract fingerprint并进入system prompt hash；任何这些契约变化都要求显式session配置迁移。

| 能力 | 调用链 | 当前契约 |
|---|---|---|
| 发现 | ToolRouter registry → ToolModule specs | 精确Zod schema和稳定顺序；direct/alias/list/describe同一策略；模型不能安装module |
| 当前环境 | environment.info → EnvironmentCapabilities → Broker.effectiveGrants + capability ports | `mate.environment.v1`只读快照；opaque grant/label、相对路径、exec/network、known-URL、actor adapter与current-target支持；动作重新授权 |
| 交流空间 | ToolRouter → Directory → acting Slack client | 已加入空间/成员/DM；权限变化重查，有界分页 |
| 历史 | ToolRouter → ConversationHistory → 可选 HistorySource | 本地分页/搜索/around；acting installation有界回填；quiet ingestion与明确coverage/gap |
| 文件 | ToolRouter → Broker → AdmittedBackend → Linux ContainerBackend / macOS SandboxBackend → 固定helper | read/list/stat/search/write/edit/move/remove/mkdir及binary；root/symlink检查；Linux与shell共用资源和清理熔断 |
| shell | Broker → AdmittedBackend → ControlledBackend → ContainerBackend | 固定本地镜像、单授权root、可停止/恢复，无host credentials/socket挂载；cleanup不确定后拒绝新执行 |
| 已知URL | Research.read | allowlist公共HTTPS IPv4、无cookies、重定向/DNS检查；不是搜索服务 |
| 附件输入 | Attachments.save → acting files.info/download → Broker.write_bytes | visible message中的fileId；下载前后ACL/运行状态检查；不接受模型任意URL/token |
| 附件输出 | Artifacts preflight → immutable outbox/draft → staged upload → share | actor+target在读文件前检查；冻结内容；分享前重查；fileId/phase持久化，unknown按分享证据对账 |
| 历史执行 | actions.list/read | 只当前Agent；执行请求/回执可查，其他对象通过当前ACL工具读取 |

[WorkspaceAccess](../../src/capabilities/workspaces.ts)在run进入模型前原子准备当前work的配置grant，works.select在其action事务中准备新work；environment.info不会补授权。配置workspace按canonical root合并，label只帮助选择，不参与授权。[Broker](../../src/policy/broker.ts)是参数规范化、唯一有效grant判定、work/stop、持久action和执行边界。环境查询与执行共用这项判定，旧报告不能绕过撤销/过期/切work/review seat。Linux production在构造Store和写入Agent文件前读取部署manifest，核对每个私有root和外部grant是独立、预分配、容量匹配的ext4 loopback mount；容量随grant进入environment.info。未知写操作保守阻挡相关root的后续变更；未知exec阻挡该Agent后续变更，仍可读取核实。不能以新action ID或换session绕过。

私有workspace是通用工作空间，MEMORY.md只是恢复入口。配置Docker后私有root可exec；镜像决定真实工具链。network默认none，owner可选bridge，后者包含可路由局域网及互联网，并非“仅公网”。review seat强制none。镜像不会自动拉取。低配默认全局1个run和1个backend operation；FIFO等待可停止，worker空闲五分钟关闭。Linux启动在Slack前清理本scope并实测固定helper和PID namespace；无法确认container cleanup会熔断新操作直到recover。

当前大小限制：file.read 64KiB；文本写/编辑/文件搜索对象最高1MB；binary read每次32KiB；write_bytes/附件输入/二进制发布最高1MB，文本发布64KiB。工具限制不等于任意模型都能一次消费最大结果：每run最多50,000保守token额度（JSON字节估计）且还受provider context限制；大文件宜search、分块或exec提取后读取。保留文件内容，输出截断有明确标记。

Jev、分类SDK、逐命令审批和相关配置已移除。未来命令审查可在Broker准备/执行之间加入独立决策adapter和持久等待状态，重用action identity、grant验证、可替换ExecutionBackend与恢复机制；当前没有伪实现或隐式审查。消息门控与其分离。

## Session演进、角色与恢复

[完整prompt](../../src/runtime/prompt.ts)描述持续同伴、自主注意力、真实人类/peer工作输入、自由知识组织、复用消息任务、进展/交接、跟进与收据，也明确当前环境快照、relative grant路径、known-URL与search区别、附件写入unknown和成果冻结/对账。角色可通过对话和memory演化；配置身份、授权不随文本改变。逐体验对照见[能力矩阵](CAPABILITY_MATRIX.md)。

每run读取最新MEMORY入口；压缩时 Engine → invalidateViews → refreshRecovery RPC → Supervisor重新读取memory、checkpoint、当前选中事项、TaskBoard分类摘要/coverage/continuation和未知动作引用，下一模型输入使用新包。恢复摘要不复制完整task result。memory/checkpoint各8KB摘录并附hash/截断和完整读取入口；refresh失败则运行失败，不冒充已刷新。原始文件不被截断。MEMORY入口应保持可读且不超过底层64KiB read限制。

sessions.checkpoint保存自述检查点；sessions.reset在run结束或崩溃恢复后替换上下文，关闭旧worker，绑定原事项的continuation，cancelled事项不再续跑，paused不绕过。所有身份/预算/任务/提醒/草稿/未知效果仍保留。owner agent-reset先停止，替换后保持paused，需显式resume。

开发机或没有workspace manifest的unmanaged环境，配置/工具prompt版本变化仍可走[离线迁移](../../src/daemon/migrate.ts)：锁 → 验证OLD_CONFIG → 旧容器恢复/fence → 数据库+私有文件备份 → 事务更换baseline并保留history、更新grants和配置快照。角色/model/channels/runtime可改、可新增Agent；已有Slack身份/workspace不可重绑定或删除。撤销/过期grant不复活，removed roots撤权，预算不重置。旧库没有身份快照时，显式legacy选项是owner对旧配置的声明，不是假造机器证据。

带workspace manifest的managed部署不允许直接调用这条旧迁移路径，因为它会在root封存checkpoint前修改数据库。受管升级走停服务、创建并root封存checkpoint、验证candidate、再迁移的部署事务；当前还要求Agent和mount topology不变。CLI拒绝把unmanaged兼容迁移路径用于受管部署。

## Checkpoint v2与受管恢复

[backup](../../src/daemon/backup.ts)在daemon停止调度并排空执行后截断SQLite WAL，对数据库和每个Agent私有workspace逐项流式复制、hash与inventory。相对路径必须规范且唯一；目录、普通文件和symlink本体分别记录，特殊文件直接拒绝。`lost+found`、control journal、external grants和backing images不进入checkpoint。完成标记最后写入并fsync；失败目录没有`COMPLETE.json`，只能由root wrapper按预先记录的目录device/inode清理，不能把一个后来替换的路径当作失败产物删除。

managed backup由部署wrapper预建service-owned空目录。备份完成后，root调用`mate checkpoint-seal CONFIG CHECKPOINT SERVICE_UID SERVICE_GID`；CLI核对live dataDir的预期部署身份，封存函数要求checkpoint父目录精确为`root:<service group> 0750`、完成树仍精确属于service身份。它自顶向下先用`O_NOFOLLOW`目录fd执行`fchown/fchmod/fsync`撤销service写权限，再枚举子项；普通文件也只通过nofollow fd修改，symlink使用`lchown`。最终目录/文件为`root:<service group> 0750/0640`并再次复核完整identity。主service已经停止、同一daemon lock已取得、backup子进程已退出和root控制父目录仍是wrapper必须保持的并发前提。

[restore](../../src/daemon/restore.ts)先验证root封存、配置摘要、Agent集合、容器镜像、external physical roots、payload inventory和checkpoint inode。取得daemon lock后，它验证Docker控制路径并清理当前execution scope，然后才扫描live workspace；Linux managed mount身份、可用block/inode和state数据库空间均在decision前证明。replace非空状态还必须提供能精确证明当前live bytes的已封存checkpoint。任何失败都不会写restore journal或修改live数据。

decision持久化后只能roll forward。每个Agent root清除并恢复后单独记账，SQLite最后以同目录临时文件、hash、fsync和rename替换；Daemon在打开SQLite前发现journal会拒绝启动。重启时已完成root按inventory复核，未完成root继续；已决策恢复不再依赖旧current checkpoint仍存在。目标源损坏或inode被替换会保留journal并阻断，root修复同一个封存source identity后可继续。version 1只保留原有“dataDir必须不存在”的unmanaged兼容恢复。

## 与参考体验仍有区别

- 前端是Slack；没有Raft自有消息服务的全局提交事务。消息任务可以锚定可见thread消息，不只顶层消息；这是Mate的明确扩展。
- 独立review seat目前由owner在从未运行过的身份和干净workspace启用，隔离所有对话/共享workspace/外部研究，强于仅目标隔离；不自动生成临时review Agent，也不提供选择性资料包。owner提供的role/brief本身仍是输入。
- 没有通用搜索、浏览器、第三方登录/集成目录；已知URL读取、配置镜像里的CLI和可信adapter是现有入口。也没有让模型自行增建身份/扩大grant的入口。
- Slack搜索只查本地可见缓存；Agent 主动发起的历史与目录查询每次有界，启动恢复用持久 cursor 遍历接收责任范围。它不是整个 workspace 的完整搜索；大文件/超长频道仍需有界读取或显式知情继续。
- unknown严格保留；没有通用“自动证明外部效果不存在”或任意owner清账工具。文件可核查、Slack消息/附件有对账路径，证据不足时需明确报告阻塞。
- 单workspace、单daemon、共享SQLite，默认串行run/backend操作且可配置。多主机、高吞吐、热加载工具未实现。macOS SRT、Docker容器边界、Debian 13原生ext4 loop workspace、专用账户、持久mount unit、systemd service、被动doctor和offline probe已实测；managed release升级/activate/fix-forward仍属后续部署gate。
- 真实Slack/provider尚未接线验收；剩余检查是权限、事件、协议、usage和错误兼容，不是“模型能否自主合作”。
