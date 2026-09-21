# 首个可用版本的交付标准（用户更新，2026-09-21）

目标：可部署到低配置Linux VPS、Agent之间沙盒隔离、通过Slack操作的可用应用。不是只交本机实验框架。默认沿用少量预配置Agent、Pi Core、SQLite单daemon、现有Socket Mode；不将动态Slack App provisioning、网页或改进Agent列为首版前置。

停止条件（或）：所有当前可做的开发/验证/打包/文档完成，之后只需接入真实Slack/provider配置与部署到VPS；或遇到无法依据现有授权/方向决定且必须由用户裁决的关键架构/功能问题。缺少部署凭证不阻塞本地开发、Linux验证或部署产物准备。不得因单个模块通过而结束整个任务。

Git：在codex/vps-first-release本地分支管理；先保存已审核及进行中工作的明确checkpoint，以后按独立审核gate提交。checkpoint不表示进行中模块已审核。私有参考、秘密和运行数据不入库；不推送远端。

下方E0–E6仍是核心实现依赖，E2b2c已通过独立审核。新增首版必交部署模块：

| 模块 | 目标/接口 | 依赖 | 验收与验证 | 状态 |
|---|---|---|---|---|
| V0 部署/隔离设计复核 | Linux单机部署、进程权限、Agent私有挂载、执行资源上限、持久目录、Slack接入、低配并发策略 | 当前架构与用户新标准 | 独立架构红队讨论；避免VM/容器套娃和不必要基础设施 | PASS，review_v0_deployment |
| V1 Linux运行与沙盒 | VPS兼容文件/命令隔离，配置化资源与并发上限，启动依赖检查与失败关闭 | E2–E5及V0 PASS | 真Linux环境的Agent相互读写/进程/secret/socket/停止与重启清理验证；非mock隔离与协议测试分开 | TODO |
| V2 部署包与Slack操作闭环 | 固定构建/运行依赖、服务管理、示例配置、诊断、迁移备份恢复、Slack操作手册 | V1 PASS、E6 | 从干净Linux环境按文档安装/启动本地替身协议；持久化/重启/恢复；凭证接入与目标机验收步骤明确 | TODO |
| V3 发布候选审核 | 完整功能/架构/隔离红队，Git可复现版本和操作清单 | E6、V2 PASS | 已知阻塞清零，只剩真实连接与部署操作；明确不能把未做验证称为通过 | TODO |

---

# 当前轮：实验版本 E0–E6（2026-09-21）

用户要求：架构设计为独立阶段，与独立红队讨论；每个后续gate额外验收软件工程质量，尤其架构边界与可维护性。历史R1–R8通过不代表此次平台解耦和Raft语义差异已解决。

| 模块 | 目标/接口 | 依赖 | 验收与验证 | 状态 |
|---|---|---|---|---|
| E0 架构与差异基线 | ARCHITECTURE、EXPERIMENT_GAPS、本计划、审核规则 | 用户最新范围、Raft证据、实际代码 | 独立红队讨论依赖、迁移、确认语义与范围；修复设计阻塞 | PASS，review_e0_architecture |
| E1 核心模块边界 | 提取conversation/attention/gate/review领域服务、平台目录port及显式composition；架构依赖检查 | E0 PASS | 原行为回归、核心不导入Slack SDK/模块及daemon；说明兼容债务，不假称ID已解耦 | PASS，review_e1_boundaries，178 tests |
| E2 内部身份与引用 | Agent定义/平台binding、opaque内部引用、Slack映射与local adapter、迁移清单 | E1 PASS | 非Slack标识全链路、本地同伴通信、同外部多App去重、旧库/JSON/unknown恢复、配置兼容 | TODO |
| E3 参与和历史 | directory参与控制、attention规则、分页搜索与around/history coverage | E2 PASS | mute mention/DM、defer、撤权并发、局部读不授全局view、新成员历史、unsupported明确 | TODO |
| E4 协作与持续工作 | 按领域分拆工具处理器；任务/提醒语义与文档；结构化状态/activity查询 | E3 PASS | 自主直接协作、认领/让位、等待/复核/后台提醒、恢复、系统事件不循环唤醒 | TODO |
| E5 工作能力与prompt | 环境/研究路径/成果闭环、手册与充分的行为约定；按前序工具同步完善 | E4 PASS | 实际授权环境能力发现与失败、附件到成果、prompt/tool/environment覆盖矩阵 | TODO |
| E6 实验验收 | 预配置少量成员的多选择场景、本地入口与真实接入操作说明 | E5 PASS | pnpm检查、故障恢复、独立架构审计；真实Slack/provider明确单列未验项 | TODO |

E2按恢复风险细分顺序gate：E2a内部Agent定义与查询边界（配置兼容投影、worker/生命周期/预算不依赖bot字段，PASS，review_e2a_identity，183 tests）；E2b内部会话/消息与外部映射及迁移（清单见REFERENCE_MIGRATION，E2b1引用目录/迁移基础PASS review_e2b1_references 190 tests，E2b2服务切换实施中）；E2c本地适配器及内部直接通信、Slack接线。E2a不会宣称旧部署配置和消息引用已解耦；后两者通过才允许E3。

E2b2在独立架构讨论后细分如下（不改变E2验收范围）：

| gate | 目标/接口 | 依赖 | 验收 | 状态 |
|---|---|---|---|---|
| E2b2a 旧载荷解释边界 | MessageDTO、LegacyConversationCodec、ConversationRecords；只读，不接生产 | E2b1 | 身份/根冲突拒绝、精确排序、wire原样、读取不写；明确不等于完成平台解耦 | PASS，review_e2b2a_codecs，197 tests |
| E2b2b 存储一致性接入 | 集中writer、backfill、所有create/update同事务维护canonical索引、目标SQL消费 | E2b2a PASS | 缺失索引失败关闭、rollback、重开、draft ACL/reminder eligibility/unknown阻挡不退化 | PASS，review_e2b2b_storage，202 tests |
| E2b2c 领域契约与canonical存储切换 | 服务/工具内部Target/MessageDTO；可变存储版本迁移与现有Slack external最小适配 | E2b2b PASS | ACL/freshness/task/reminder/new writer/recovery一起切；两次重开、原wire不变、旧action等价重试/变参拒绝 | PASS，review_e2b2c_canonical，220项通过 |
| E2c 内部通信与适配器 | 内部原子消息/delivery、投影及完整local接入；config解绑 | E2b2c PASS | 内部提交/投影失败、外部确认/echo/根回复、非Slack完整链路 | TODO |

基础gate不接生产、不改SQL，避免半切换；生产writer、索引维护与查询读者仍必须同gate切换。此拆分已与review_e0_architecture讨论同意。

每模块不得在前一gate通过前实现；必要时按具体风险拆小gate。代码验证后才启动独立红队，阻塞修复后复审。凭证缺失只阻塞对应真实集成。生产部署、完整动态创建表单/Slack provisioning、SSH部署、独立网页与改进Agent不作实验前置。

---

以下为历史记录；当前执行以上表及E系列review为准。

# Mate 实施计划

2026-09-20；依据 HANDOFF、技术设计、v1 scope 与本地 Raft 只读证据。工作目录与已保存项目 mate 路径均为 `/Users/chris/Developer/demo/mate`。

当前进度：R1–R8已逐模块实现、检查并通过独立红队；普通176 tests、真实本地隔离7/7通过。A–H及R0下的说明为历史阶段记录；当前模块表与文末最新gate记录优先。

## 交付规则

模块按下表顺序实施。每个模块先通过本地检查，再由未参与实现的独立红队读取真实代码/测试；修复所有验收阻塞并复审后才启动下一模块。审核记录写入 `docs/reviews/`。外部凭证缺失不阻塞纯本地实现，但模拟验证不代表真实服务验收。

| 模块 | 目标与接口 | 依赖 | 验收与有意义验证 | 状态 |
|---|---|---|---|---|
| A 基础与 SDK 契约 | TS ESM、锁定依赖、配置校验；验证 Agent/message_end/tool/idle、TypeSafe 请求接口、SQLite | 无 | 实际安装类型检查；假模型驱动真实 Pi 工具循环、异步订阅屏障与失败行为；SQLite 事务回滚；SDK 离线传输契约 | PASS，review_a，11 tests |
| B 持久状态核心 | Store：Agent/session/journal、inbox、run generation、intent/outbox、恢复与备份 | A | 关闭重开数据库、去重、单 Agent 单 run、旧 generation 拒绝、未知副作用不重放、输入/journal 原子提交 | PASS，review_b，19 tests |
| C Slack 消息服务 | 持久 receiver、normalize、ACL、attention、read/search/send、显式 target、outbox 对账 | B | commit-before-ack、双 app/echo 去重、乱序编辑删除、撤权、429/unknown 故障注入；真实 Slack 另验 | PASS，review_c，27 tests |
| D 协作与调度 | tasks/dependencies、work budgets、subscriptions、持久 schedules；owner 控制 stop/resume | C | CAS 认领、等待释放、继承预算、取消和 catch-up 幂等、依赖完成原子唤醒 | PASS，review_d，34 tests |
| E 权限与执行 | trusted broker、grants/intents/approvals、Jev 官方 SDK、隔离 backend、文件与 memory 原子写 | D | 跨 Agent/路径/符号链接/过期审批/变参攻击；Jev 失败关闭；真实本地沙箱阻断与停止；中文 Jev 评测待凭证 | PASS，review_e，40普通+3真实测试 |
| F Pi worker 与上下文 | restore/run/checkpoint/compact/abort、IPC、每 Agent 独立进程、memory 恢复包、合法工具投影 | E | 两频道同 session、两 Agent 独立、message_end 持久屏障、kill/restart、压缩闭合边界、审批释放/停止 | PASS，review_f，55普通测试 |
| G daemon 与日用验收 | main、Slack 管理入口、研究/成果工具、运维日志、备份恢复、配置示例与启动文档 | F | 合成双 Agent 全链路、故障矩阵、配置 fail-fast；真实 Slack/model/Jev 及任务质量比较独立列为未验 | PASS，review_g，68普通+4真实测试 |

以上 A–G 为历史交付记录；旧 Jev、审批及模型质量验收要求已由下方 H 和用户最新 harness 指令取代。

## 与交接设计的关系（历史）

- 将 M0–M3 按基础依赖分解为 A–G；风险契约分布在 A（SDK）、C（ack）、E（沙箱/Jev）、F（worker/压缩）。不把尚未实现的 M0 全部标为完成。
- 保留应用拥有的 SQLite 事务边界、Pi Core + pi-ai、官方 TypeSafe SDK；不引入 coding-agent。
- 主机当前 Node 为 26.8.2，设计要求 Node 24；优先获取本项目隔离的 Node 24 工具链，不更改用户系统默认 Node。
- Jev 在完成真实校准前只作为信号，不能根据未校准分数自动扩大执行权限。
- E红队实测发现macOS SRT的进程组清理不能停止setsid/detached子进程。因此任意shell改为独立容器PID namespace，正常/abort/timeout均确认容器删除；结构化文件仍用SRT。该调整使用设计预留的ExecutionBackend替换边界，增加本地Docker与固定镜像前提，不退回无限制shell。
- 本地私有 reference 不进入 Git，测试全部使用合成内容。不部署、推送或发送外部消息。

## 当前验收范围

假设模型足够智能，验收 harness 的工具、环境、system prompt、控制流、持久状态与恢复，不评测模型性能或自主协作质量。脚本化模型测试是有效的机制验证。真实 Slack/provider 待验仅包括安装身份、scopes、bot echo、协议、usage 与错误兼容；其他 OS 隔离和正式备份恢复也尚未验收。

A–G 历史检查与独立红队记录保留；当前检查结果见 `docs/ACCEPTANCE.md`。未启动真实服务、发送消息、推送或部署。

## H — pnpm、移除命令审查与代码导览（2026-09-20 用户新指令）

本次指令覆盖交接稿及AGENTS中旧Jev要求：当前不需要Jev或逐命令审批。保留目录/operation grants、隔离backend、预算、停止与动作回执；未来审查可插入Broker的准备/执行边界，当前不保留分类器或闲置审查实现。

| 子范围 | 目标/接口 | 依赖 | 验收与验证 | 状态 |
|---|---|---|---|---|
| H（单个交付模块） | pnpm固定版本+唯一lockfile；删除SDK/分类/审批路径及配置；Broker→ExecutionBackend边界保留；v7兼容迁移；源码调用链与feature差距说明 | A–G | pnpm冻结安装、原生依赖、全测试；授权内exec直接执行/越界与未知副作用仍拒绝；v6遗留审批失效而不自动执行；独立红队检查实际代码与说明 | PASS，review_h，66普通+4真实隔离测试 |

旧review记录与reference保留为历史证据，并在当前入口标明已被本次决策取代。调用链说明以harness为验收对象，假设模型足够智能；检查工具/环境/prompt可达性、持久状态与恢复。脚本化模型验证机制即可，不将模型性能或自主性质量作为待办；真实服务检查只关注协议、权限、usage和错误兼容。


## R0 — 重新定位与消息门控调研（本轮范围）

用户明确将Raft的模型主观能动性置于产品核心。本轮交付项目定位、证据分层的门控调研、替代架构与后续模块计划；不把研究请求扩成未经设计的runtime重写。

| 模块 | 目标 | 接口/产物 | 依赖 | 验收与验证 | 状态 |
|---|---|---|---|---|---|
| R0 | 从受限work执行器重新定位为持久自主Agent的协作环境；调研注意力与发送时门控 | PROJECT_DIRECTION、MESSAGE_GATING_RESEARCH、README/AGENTS/交接入口、后续R1+接口和依赖 | 原始Raft prompt/对话证据、当前源码、官方公开材料 | 明确事实/建议/实现状态；解决八项语义偏移；门控保留读取/修改/沉默/显式继续选择，描述Slack一致性边界；独立红队审查 | PASS，review_r0；仅文档设计 |

R0阶段约定：不把旧A–H的PASS当作新定位验收；R0当时只完成定位研究，代码模块的后续实现与gate记录如下。


## 重新定位后的代码模块（已获实施授权）

用户已要求逐模块实施。下表是依赖顺序及当前状态；每个模块实现后都需要独立review gate，必须检查原意/行动空间，不能只检查所选路径的健壮性。旧数据库升级需提供备份、映射和可恢复失败路径，不删库重建冒充迁移。

| 模块 | 目标与接口 | 依赖 | 验收与有意义验证 | 状态 |
|---|---|---|---|---|
| R1 身份/消息/预算基础 | Conversation的channel/thread/dm与revision；Agent/run/预算账户/任务引用分离；显式账户归属与授权 | R0 | 顶层发言、主动DM、同Agent跨事项读取和切换；有限持续账户支持非human触发；不可借切换重置预算；旧work与target迁移回归 | PASS，R1a/R1b |
| R2 注意力与呈现 | Attention.peek/read/defer/resolve，watch/mute，分页coverage/viewToken，Pi运行中notice与ACK | R1 | 新消息在断点可见但不强制读正文；结束run不清未读；分页/编辑/晚到/崩溃不错误推进seen；跨频道可暂缓/转向 | PASS，review_r2，95 tests |
| R3 提交门控 | FreshnessGate、draft生命周期、发送前再检查、有限知情继续、全输入路径review seat隔离 | R2 | 调研表全部相关竞态；变更hold/重启草稿/四选项/热频道活性/盲审不泄漏/Slack竞态显式记录；不启用命令审查 | PASS，R3a/R3b |
| R4 消息任务 | canonical message claim、unclaim/transfer、状态投影、可选dependency；接R3任务门控 | R3 | 同一消息并发转换/认领唯一；hold无副作用；任务版本冲突；可直接协作或用任务，无强制总管/任务树；人类可见状态 | PASS，review_r4，115 tests |
| R5 工具与workspace | ToolEnvironment注册/描述/执行adapter；私有workspace完整文件能力；可配置联网与工具链、附件输入输出 | R4 | 合成资料检索/脚本/文件组织/发布全链；不依赖外部私密凭证；真实backend停止/崩溃隔离；其他Agent私有空间不可访问 | PASS，R5a/R5b1/R5b2 |
| R6 作者拥有的提醒 | Reminder内容/锚点/版本/改期/取消/日志；独立于已完成task，绑定持续预算策略 | R5 | 完成任务后提醒仍触发本人；可见回执不乱唤醒；取消与已入队区分；catch-up去重；旧schedule显式迁移 | PASS，review_r6，156 tests |
| R7 session演进与prompt | 逻辑身份/current session、检查点/重置/配置迁移、压缩后memory刷新、完整行为约定 | R6 | 角色更新/换session保持身份/未读/任务/提醒/草稿；旧view失效；memory内容自由；不可恢复窗口如实说明 | PASS，R7a/R7b/R7c |
| R8 产品语义验收 | 合成多Agent场景与故障矩阵、README/current behavior重写 | R7 | 覆盖多种合法选择而非固定合作剧本；真实Slack/provider仅协议接线；独立审查对照Raft原意及用户修正逐项判定 | PASS，review_r8，176普通+7真实 |


### R1细分与当前执行顺序

R1同时涉及消息契约与预算模型，拆成两个独立gate，避免一次大改掩盖语义回归。

| 模块 | 目标/接口 | 依赖 | 验收与验证 | 状态 |
|---|---|---|---|---|
| R1a 交流空间 | Target.thread可选；频道/DM顶层发送、对账；Directory.spaces/members/openDM；本地message event revision；v8迁移前备份 | R0 | 模拟Slack transport验证顶层无thread_ts、新DM及权限、unknown不重放、旧thread兼容；编辑/删除/晚到revision；旧库备份与重开 | PASS，review_r1a，77 tests |
| R1b 预算与事项解耦 | 持续Agent账户、事项控制与run/action预算归属分离；跨事项read/claim/update，保留授权与债务 | R1a | 无新human预算重置；同Agent不同事项切换；耗尽不暂停全Agent；停止、继承额度、未知用量与旧work迁移 | PASS，review_r1b，84 tests |

R2及后续模块维持上述依赖，R1a红队通过后才实施R1b。整个重构不会引入Jev或改变Pi Core选型。

R1b实现约定：预算账户按Agent持久化，配置仅首次播种；owner的`agent-budget`修改累计上限，human/peer消息不补额。旧work上限保留为可选事项上限；一次模型run全部计入Agent账户和起始事项（账单归属不随中途切换改变），run_context单独控制后续动作与停止/continuation。`works.select`检查目标可见性并取得该事项的配置授权，`tasks.read/claim/update`按可见性/所有权独立判断。v9先备份；旧work只有聚合usage，首次账户初始化把该Agent参与过的work全部usage保守计入账户，可能高估但不丢未知债务，并记录audit；不伪称历史可精确拆账。账户耗尽等待owner补额，不自动无限提供控制模型额度；工具读取不会再被事项ID拒绝。

R2接口落地：Attention.peek/read/resolve/defer/mute与channel/thread watch；不可变分页快照，viewToken绑定Agent/session/context epoch/target/revision，完整toolResult随journal事务ACK才计呈现。现有messages.read/search保留为检索，不签发整目标凭据。最多10000条本地可见消息的有界快照，超限/截断明确不完整，不假称完整阅读；后续R3允许知情继续而非强制读尽。Pi每次模型调用前通过nonce RPC拉取content-free notice，通知写journal后进入本次输入投影；不终止当前工具、不强制读正文。压缩与run投影交接保守失效viewToken；seen/resolved/deferred独立持久化，结束run不resolve。defer到期在tick产生一次持久唤醒；mute抑制新唤醒，不撤销已开始的run。

R3分为两个独立gate：R3a实现消息草稿/提交与dispatch前门控、重试/修改/丢弃/一次知情继续、429/unknown与重启；R3b实现owner授权的独立review seat和统一输入隔离。R4再接任务CAS门控。R3a依赖R2，R3b依赖R3a；各自完整测试与独立审核后才进入下一部分。

R3a实现：生产ToolRouter为Output安装FreshnessGate；所有普通消息/委派消息经持久outbox held状态与draft revision。首次无basis保留草稿；retry需要有效呈现view；revise生成新的不可变outbox版本；discard静默；continue绑定当前holdId+revision，只授权60秒内该草稿的一次成功派发，不推进seen。dispatch全局串行（强于目标串行），已观察改变再hold并产生去重持久唤醒，429再次检查，unknown阻挡同目标后续派发并等待对账。普通消息scope及任务变更CAS门控分开；任务gate属R4，artifact.publish适配器的提交门控属R5，不将R3a称作已覆盖所有外部工具。R3b另验盲审输入隔离。

R3a状态：PASS，review_r3a，104 tests。R3b开始实施，所有后续模块尚未完成。

R3b实现约定：owner `/team review-seat AGENT_ID {"target":...,"brief":"..."}` 启用一次独立席位。必须从无run/非初始journal/snapshot/outbox的身份开始，daemon验证私有workspace只有未改动模板MEMORY和空notes/artifacts；角色配置及brief是明确owner提供的基线，不能声称消除其中已有信息。席位期间不读取任何对话/peer输入（比只屏蔽目标更保守，防止跨频道转述旁路），不提供外部研究/共享workspace/任务正文/inbox入口；允许自己的干净workspace文件读写、opaque notice、自己的草稿和独立发言。Supervisor对持久输入统一投影为owner brief，恢复只含自身memory/当前不透明work ID，不含来源正文/作者/讨论时间线；Broker拒绝共享workspace grants。owner review-release会停止Agent再解除隔离，需明确resume，不允许Agent自己退出。R5将分别接入指定资料/环境能力，不把席位限制作普通Agent的限制。

R3b边界补充：生产私有workspace当前仍只有read/write grants，独立seat脚本exec的实际授权随R5统一workspace工具恢复；R3b不以工具白名单含exec声称已可计算。seat持久user输入timestamp固定0，不暴露被隔离delivery的时间线。

R3b状态PASS，review_r3b，107 tests。R4开始实施：原始message唯一锚点、任务CAS claim/unclaim/transfer/update，任务held intent与消息draft分离；新任务先发可见消息再激活投影；任务提交通过门控后发布由harness生成的固定状态通知，通知不作为模型意见再次接受freshness判断。历史无原始消息映射的任务保留legacy标记，不猜测将多个旧task合并成同一Slack消息。

R4实现接口：tasks.byMessage/claim(message|taskId,expectedVersion,viewToken)/unclaim/transfer/update；tasks.intents/retry/continue/discard管理持久held intent。门控hold不创建canonical task、不改owner；通过后同事务唯一message_key与version/owner CAS。tasks.create生成draft消息，confirmed后activate才绑定message_key并唤醒创建者；未确认不可claim。固定状态通知包含task/source/owner/version，仅在提交成功后由harness生成，不是自由文本freshness绕过入口。legacy=1表示旧库没有可证明原始消息锚点，不自动猜测或合并；新消息认领总走唯一索引。wait支持跨事项可见依赖，醒回waiter自身事项。

R5拆为两个顺序独立gate：R5a工具注册/发现、私有workspace执行授权及结构化文件操作（目录/查找/编辑/移动/删除），保留backend停止与隔离验证；R5b配置环境网络/工具链、资料与Slack附件输入输出、artifact提交门控。接口分别为ToolEnvironment+Broker/ExecutionBackend，以及环境/附件adapters+durable publication。R5a依赖R4，R5b依赖R5a；真实本地隔离检查和独立红队通过后才继续。

R5a实现已通过独立审核：ToolEnvironment可信adapter注册/描述/执行，tools.list/describe/call，别名与直接调用统一进入原有router授权/回执边界；system prompt只列发现协议和能力目录，精确schema按需获取。file.list/stat/search/mkdir/edit/move/remove经Broker映射read/write权限，编辑使用SHA256+唯一文本匹配，move不覆盖，remove仅文件/空目录；所有写保护workspace根，双路径检查，未知变更保守阻挡同root后续变更，仍允许读取核实。固定SRT helper从stdin接收操作，避免大文件argv限制；文本文件1MB、read64KiB、搜索/列表有界并返回truncated。配置Docker后私有workspace获得exec，已存在未撤销未过期私有grant显式审计升级，保留过期/撤销状态。普通125 tests、真实本地隔离6/6通过；review_r5a独立44 tests及真实Unicode回归通过；记录见reviews/R5a-tools-workspace.md。

R5b继续按风险边界拆成顺序gate：R5b1先把artifact.publish接入统一outbox/draft/FreshnessGate，冻结文件内容，记录上传fileId，支持unknown按Slack分享证据对账，避免附件绕过提交控制；R5b2再提供附件读取/保存及可配置网络/工具链。R5b1依赖R5a，验收hold/revise/discard/continue、排队后变更/停止、未知上传不重发、同文件证据恢复；R5b2依赖R5b1，验收可见消息附件ACL/下载URL边界/二进制文件往返、环境配置与工具发现。每个独立红队通过后才继续。

R5b1 PASS，review_r5b1；普通135tests，独立全套134（最后新增截断test前）及最后相关40tests通过。详情reviews/R5b1-artifact-gating.md。artifact frozen payload进入统一outbox，上传allocation fileId与staging/sharing持久化；分享前重查，unknown按files.info分享证据对账。publication caption独立分页/ACK/seen，不伪造Slack消息ts。R5b2需消除附件echo双计数；R8需修既有outbox ready前序阻挡公平性。

R5b2实现已独立审核通过：NormalMessage保留文件metadata并补齐旧同版本cache；attachments.save经消息可见性/当前Actor files.info与认证下载（拒绝URL输入与重定向），下载前后检查ACL，Broker写入最多1MB二进制文件。file.read_bytes分块/sha256、write_bytes原子写；artifact binary模式逐块一致哈希快照，草稿不暴露大块base64。environment.info展示固定镜像/network/researchHosts，owner可选none/bridge，bridge明确包括可路由本地网络；review seat强制断网。publication/Slack echo按fileId+caption+作者+target去重；有界文本/二进制限制明确，真实后端测试另记录。

R5b2 PASS，review_r5b2，普通144 tests（独立全套复验相同），真实本地隔离7/7。R5整体完成。两项附件ACK/echo竞态修复记录见reviews/R5b2-attachments-environment.md；下一模块R6作者拥有的提醒。

R6具体接口/迁移约定：reminders.create/read/list/edit/cancel/log管理作者自己的content、target、可选消息anchor/task引用和version；旧schedules工具保留兼容入口，写操作接同一版本检查。v14保留原schedule ID/active/nextAt，补legacy内容标记和事件日志，不擅自重启历史已取消提醒。任务完成不改变提醒；显式事项pause/cancel仍控制其提醒，所有触发计入持续Agent账户并保留事项上限，不补预算。触发原子写delivery+firing日志+固定可见回执（不发布模型撰写的提醒正文），只唤醒作者；漏过多次cron合并一次再推进到未来。取消默认只取消未来，可显式撤回尚未注入的pending触发，已注入的run单独报告，不伪称撤回。验证任务完成后触发、版本冲突、其他作者拒绝、取消/注入竞态、重启去重、预算/ACL/owner停止和v13迁移。

R6 PASS，review_r6；普通156tests，独立全套相同及额外2项边界通过。初审发现批次LIMIT前未过滤不可触发提醒的饥饿，已修复并覆盖ACL/Agent预算/work预算。详情reviews/R6-author-reminders.md。

R7拆为顺序独立gate：R7a检查点与受控session更换（模型sessions.checkpoint/reset/status、owner reset；请求在run结束或重启恢复后应用，持久身份/任务/提醒/草稿/预算不变，旧view失效，工作继续受pause/cancel约束）；R7b离线显式配置/工具prompt迁移（单实例锁、备份、旧身份核验、运行环境授权差异处理，不删库重建）；R7c完整自主行为prompt及压缩后memory/checkpoint刷新。各自检查及独立红队通过后推进；R8最后重写current docs并做产品语义验收。R7a验证中断窗口、重复reset不重复轮换、恢复未知动作债务、跨会话私有身份和事项控制；R7b验证失败不部分启用配置；R7c验证新恢复内容真正进入下一次模型输入，不评价模型质量。

R7a PASS，review_r7a，正式161 tests；补齐跨session自身执行回执查询，并修复历史非执行回执的间接ACL旁路。详情reviews/R7a-session-lifecycle.md。R7b采用离线显式OLD_CONFIG/NEW_CONFIG/BACKUP命令；身份不重绑定，完整配置快照用于后续核验，旧库无身份快照时需明确声明旧配置可信；保留history并更新baseline，保留撤销授权/预算/unknown，变更事务失败可恢复旧配置。

R7b PASS，review_r7b，167 tests及独立额外4项通过。迁移命令与完整配置快照、身份限制、备份/事务回滚、历史baseline更换及grant收敛已落地。取消固定三Agent上限，单Agent额度不再除以全队人数。R7c现在实施完整行为prompt和压缩后的恢复刷新，不改变模型评测范围。

R7c PASS，review_r7c，普通170 tests；独立runtime36及真实RPC故障注入通过。完整prompt已对照产品定位和Raft参考，恢复包在压缩后实际重读memory/checkpoint/selected work并进入下一模型输入。R7整体完成，进入R8多选择语义验收、outbox公平性和当前文档收口。

R8 PASS，review_r8。五种合法决策通过真实Pi loop与持久状态验证，修复outbox前序unknown/ingress阻挡造成的批次饥饿；当前文档完整重写并保留明确差异。独立176 tests、类型检查通过，实现方真实本地隔离7/7；详情reviews/R8-product-semantics.md。R1–R8全部完成；真实Slack/provider协议接线仍未验，不属于模型性能/智能验收。

### E2c 子模块（内部通信完整范围不缩减）

| gate | 目标/接口 | 依赖 | 验收与验证 | 状态 |
|---|---|---|---|---|
| E2c1 | 持久内部DM、原子消息/delivery、local入口；production按authority路由 | E2b2c PASS | pair唯一/重开/事务回滚/同ID变参拒绝；gate/ACL/停止/work绑定/review seat；本地会话不误入Slack巡检；历史openDM原路由保留 | PASS，review_e2c1_internal，229 tests |
| E2c2 | 独立projection outbox、可信echo归并、人类回复导入 | E2c1 PASS | 投影失败不撤销内部提交；unknown不盲重投；早到echo/线程根缺失暂存/撤权/不循环唤醒 | TODO |
| E2c3 | 内部Agent配置与平台binding独立；local/Slack组合入口与迁移 | E2c2 PASS | 无Slack配置的完整运行路径；旧配置兼容与身份不重绑；配置/端口不泄漏进核心 | TODO |

每个子模块通过独立红队后继续；E2c1不把尚未支持的附件/投影伪装为成功。新内部DM必须接入现有生产目录，Slack轮询只访问属于自身adapter的external会话；不能留下局部实现使daemon崩溃。旧持久openDM动作按原路由恢复，只有新动作选择internal peer通信。

E2c2继续按确认风险细分：c2a核心projection授权/状态/原子入队/绑定确认，测试fake transport协议及故障；c2b真实Slack适配、导入/延迟根/revision、多App去重及owner管理接线。两个均需独立红队；c2a中未接线的adapter不得标为可用。参考ARCHITECTURE末尾的确认、旧根anchor、停用、drift与防反射契约。

E2c2a PASS：review_e2c2a_projection，238普通checks/7环境skip；c2b开始前需落实projection查询分页和旧故障可发现性（c2a非阻塞P2）。

E2c2b PASS：review_e2c2b_slack_projection，245普通checks/7环境skip；真实Slack回复截断破坏游标的阻塞已修复并经实际admin queue路径验证。E2c2整体完成，进入c3配置解绑与完整本地常驻入口。

E2c3按可独立审查的风险拆成c3a/c3b顺序gate：c3a统一配置兼容解析、纯Agent定义与可选平台binding、稳定human映射/owner权限分离及离线身份迁移；c3b同一daemon的可选adapter生命周期、完整local常驻入口、持久room ACL与外部故障隔离。c3a的local配置可解析/用于应用服务，但尚不宣称local常驻daemon可启动；c3b通过才完成c3。两者均需实际代码与软件工程独立红队，不能以配置类型存在代替可用入口。c3a验收旧快照规范化不改变wire/hash、owner撤销不改author、binding子集保留内部Agent、禁止身份移除/换绑；c3b验收见ARCHITECTURE。

E2c3a PASS：review_e2c3a_configuration，252普通checks/7环境skip；修复local-origin首次绑定Slack后启动被错误拒绝的P1，独立复验包括已有本地消息正文不变。完整记录reviews/E2c3a-configuration.md。进入c3b同一daemon可选adapter生命周期与本地常驻入口。
