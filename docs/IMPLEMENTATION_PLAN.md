# Mate 实施计划

2026-09-20；依据 HANDOFF、技术设计、v1 scope 与本地 Raft 只读证据。工作目录与已保存项目 mate 路径均为 `/Users/chris/Developer/demo/mate`。

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

不把旧A–H的PASS当作新定位验收。后续代码模块需要各自实现、检查、独立review gate，本轮不将其标为完成。


## 重新定位后的代码模块（已获实施授权）

用户已要求开始逐模块实施。下表是依赖顺序；R0已完成，R1起逐个实现。未来每个模块实现后都需要独立review gate，必须检查原意/行动空间，不能只检查所选路径的健壮性。旧数据库升级需提供备份、映射和可恢复失败路径，不删库重建冒充迁移。

| 模块 | 目标与接口 | 依赖 | 验收与有意义验证 | 状态 |
|---|---|---|---|---|
| R1 身份/消息/预算基础 | Conversation的channel/thread/dm与revision；Agent/run/预算账户/任务引用分离；显式账户归属与授权 | R0 | 顶层发言、主动DM、同Agent跨事项读取和切换；有限持续账户支持非human触发；不可借切换重置预算；旧work与target迁移回归 | PASS，R1a/R1b |
| R2 注意力与呈现 | Attention.peek/read/defer/resolve，watch/mute，分页coverage/viewToken，Pi运行中notice与ACK | R1 | 新消息在断点可见但不强制读正文；结束run不清未读；分页/编辑/晚到/崩溃不错误推进seen；跨频道可暂缓/转向 | PASS，review_r2，95 tests |
| R3 提交门控 | FreshnessGate、draft生命周期、发送前再检查、有限知情继续、全输入路径review seat隔离 | R2 | 调研表全部相关竞态；变更hold/重启草稿/四选项/热频道活性/盲审不泄漏/Slack竞态显式记录；不启用命令审查 | PASS，R3a/R3b |
| R4 消息任务 | canonical message claim、unclaim/transfer、状态投影、可选dependency；接R3任务门控 | R3 | 同一消息并发转换/认领唯一；hold无副作用；任务版本冲突；可直接协作或用任务，无强制总管/任务树；人类可见状态 | PASS，review_r4，115 tests |
| R5 工具与workspace | ToolEnvironment注册/描述/执行adapter；私有workspace完整文件能力；可配置联网与工具链、附件输入输出 | R4 | 合成资料检索/脚本/文件组织/发布全链；不依赖外部私密凭证；真实backend停止/崩溃隔离；其他Agent私有空间不可访问 | 未开始 |
| R6 作者拥有的提醒 | Reminder内容/锚点/版本/改期/取消/日志；独立于已完成task，绑定持续预算策略 | R5 | 完成任务后提醒仍触发本人；可见回执不乱唤醒；取消与已入队区分；catch-up去重；旧schedule显式迁移 | 未开始 |
| R7 session演进与prompt | 逻辑身份/current session、检查点/重置/配置迁移、压缩后memory刷新、完整行为约定 | R6 | 角色更新/换session保持身份/未读/任务/提醒/草稿；旧view失效；memory内容自由；不可恢复窗口如实说明 | 未开始 |
| R8 产品语义验收 | 合成多Agent场景与故障矩阵、README/current behavior重写 | R7 | 覆盖多种合法选择而非固定合作剧本；真实Slack/provider仅协议接线；独立审查对照Raft原意及用户修正逐项判定 | 未开始 |


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
