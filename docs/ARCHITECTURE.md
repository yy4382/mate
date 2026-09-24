# Mate 实验版架构设计

状态：E0 独立红队讨论及复审 PASS，2026-09-21。本文为目标设计，不声明代码已经符合。取代旧设计对 Slack 为核心实体、静态团队、固定协作流程的假设。保留 pnpm、Pi Core + pi-ai、SQLite、单 daemon、每 Agent 单主 run。

## 1. 目标与阶段

实验版验证足够智能的模型在工具、环境和 prompt 下可达的行为。预配置少量成员即可，不需要先完成 Slack App 自动创建或网页；Debian 13 VPS 与 Slack 操作属于首版交付。内部设计支持后续动态成员、CLI/web/其他通信适配器。核心体验包括持续身份、自主注意力、直接协作、可检索历史、认领/交付、提醒、真实工具和人类介入。

不引入微服务、事件总线产品、通用插件框架、第二事实源、Jev或逐命令审查。Agent 自主性不等于授予模型修改身份/权限的能力；明确的人类指令才授权新增成员。此次不增加自动创建成员的定时任务。

## 2. 责任与依赖

| 模块 | 拥有的状态/责任 | 可依赖 | 禁止 |
|---|---|---|---|
| domain | 平台无关 Agent、principal、conversation、message、attachment 引用及验证 | zod、纯函数 | Slack SDK、数据库、runtime、传输格式 |
| agents | 身份/角色/模型配置查询，配置播种，生命周期服务 | domain、Store | 把 bot token/app ID 作为 Agent 必填字段 |
| conversations | 消息归一后的存储/版本、可见性、检索、参与策略、输入分发 | domain、Store、Agent 查询 | SDK调用、Slack mention解析/ts排序 |
| attention / coordination / reminders | 呈现/门控、规范任务所有权、未来唤醒 | domain、conversations、Store、必要的窄接口 | 从 Slack echo 才完成内部 Agent 通信 |
| runtime | Pi循环、工具调用、上下文/恢复、每 Agent 串行调度 | 上述应用服务、ExecutionBroker | Slack API、平台身份规则 |
| adapters/slack | 验签/接收、身份和引用映射、历史/目录/附件/传输、表单与平台差异 | 应用服务、domain、Slack SDK | 决定任务/注意力/预算业务规则 |
| adapters/local | 本地输入/输出及可重复实验 | 同样的应用服务和domain | 为测试实现另一套业务逻辑 |
| execution | 以每位 Agent 的 Linux 用户账号运行普通命令；系统级命令先等用户批准；记录执行结果并支持停止 | Store、发起操作的 Agent 和当前运行信息 | 用发送消息前的检查代替系统命令审批 |
| daemon | 配置转换、构造服务、调度、shutdown | 所有实现 | 在工具里临时构造SDK或通过全局服务定位器取依赖 |

Store 暂时是共享 SQLite transaction/repository 基础设施；不为每张表制造接口。事务拥有者是执行用例的应用服务，跨状态原子操作保持同一连接。网络/执行器操作不得在数据库事务内等待。后续拆 repository 以实际独立职责为依据。

工具按会话、任务、提醒、工作环境、管理分组；ToolRouter 仅完成 schema 校验、可信上下文、统一调用与回执协议，不持续增长为所有业务逻辑的 switch。此次逐模块迁出所触及的处理器，不一次重写无关功能。

## 3. 身份与通信模型

内部 ID 为不透明非空字符串，带独立 schema；不能从 C/D/U 前缀推断空间或成员类型，也不能将消息 ID 当时间戳比较。Agent 身份不变，session 可替换，角色/配置可演进，workspace 独立。Principal 包含 human/agent/system/external 来源；AdapterBinding 单独记录 platform、installation、externalId、internalId。

Conversation 具有 id、kind(channel/dm)、authority(internal/external)、可见性和成员；Target = {conversationId, threadId?}；Message = {id, conversationId, threadId?, author, mentions: PrincipalId[], content, attachments, occurredAt, revision}。本地 revision/sequence 是可比较整数；外部 revision 由适配器验证并转换，Slack ts 仅存在映射中。线程根引用指向消息；任务锚定内部messageId。mentions由可信adapter解析平台实体并映射principal，核心不解析Slack文本。正文保持原文；system来源只能由可信系统事件证明，不能由文本或任意metadata自称。

对同一个外部消息的多App观察先以(provider,workspace,channel,messageId)唯一映射到同一内部ID，再合并观察者可见性；不能把一位bot看见等同所有成员可见。撤权阻止后续读取和发送，不承诺从模型已读上下文抹除历史。

持久内部消息与对外投影不同：内部会话send同事务产生message、revision和收件人delivery，可直接唤醒同伴；若启用外部投影，再写projection outbox。外部目的会话send先保存意图，收到平台确认后记录可见消息；unknown不声称成功。echo通过绑定和receipt合并，不双重唤醒。系统activity默认不触发Agent回复。

### 3.1 会话权威与投影绑定

每个会话持久authority，创建时确定，实验版禁止运行中切换。旧Slack会话一律external，保留原确认语义。external会话有唯一主binding(provider,workspace,externalConversationId)，内部Agent DM可以是internal并不要求Slack bot能互相DM。internal会话有零或多个显式projection绑定，projection失败只影响展示，不撤销内部已提交消息/任务或重复唤醒。

internal发送同事务提交message + delivery + projection outbox；external发送在confirmed时提交message + delivery。每个收件人按内部messageId/revision去重。projection保存内部messageId、projectionId、payload hash、外部receipt；Slack echo通过可验证的安装/作者/内容/目标和metadata绑定归并，只补外部定位信息，不重新触发同一消息的delivery。不得仅相信用户可伪造的metadata。

投影频道的新人类输入以外部唯一locator导入内部会话一次，再走正常当前成员ACL与分发；自己的确认echo只归并。缺少可信匹配的外部输入按普通新消息处理，不能吞掉。多个bot的重复观察合并可见性而非重复消息。不存在投影授权的DM不投影。系统activity投影标记由可信系统产生，默认不唤醒成员。

| 并发/失败情形 | canonical结果与恢复 |
|---|---|
| 内部提交成功，投影unknown | message/delivery已经成立，保留projection unknown，阻止盲目重投；不撤销内部工作、不二次唤醒 |
| 外部发送unknown | 尚无confirmed canonical发送结果；按原wire证据对账，证明后同事务确认与delivery一次 |
| 合格echo先于HTTP回执 | 唯一外部locator与outbox证据原子关联；后续HTTP回执归并同一message/delivery；不合格metadata按普通输入，不冒充确认 |
| 人类回复投影消息 | external thread-root经projection receipt映射到内部根；根映射尚未到达则持久暂存，重放时映射，不猜成顶层。按外部当前发件成员身份和内部会话导入策略校验，再按内部收件人ACL分发 |

投影绑定明确允许导入哪些外部成员，默认仅绑定的内部成员；外部频道可见不自动等于内部私聊成员。撤权后不得回放旧投影正文给新无权成员；映射查询本身也执行授权。先到echo与HTTP统一走确认用例，而不是各自写message和work。

## 4. 适配器接口与能力差异

ConversationDirectory 提供 list/members/openDM/join/leave；返回明确capabilities与incomplete/coverage。MessageTransport处理外部发送/对账；HistorySource负责范围读取，AttachmentPort处理外部附件；这些接口使用内部引用，Slack适配器负责翻译。

目录列出不代表有read/send权限。公开未加入的空间是否可读由平台能力决定；私有空间不得借发现接口扩大访问。join/leave成功后更新持久membership；失败区分明确拒绝和unknown，重试不伪造成功。能力不支持返回可解释结果，不静默模拟。

命令路径：可信actor/run → 应用服务校验 → SQLite准备意图 → adapter副作用 → SQLite回执。进程恢复后执行中副作用标unknown；只有确定幂等或有证据对账才重试。相同action ID的参数变化拒绝。保留run generation fencing、stop、ACL、budget和review seat限制。

## 5. 注意力、任务和提醒语义

- mute抑制普通活动；个人mention/DM穿透频道静音。defer是明确暂缓目标处理，新输入保留，不等于已读；是否唤醒依照独立规则并在工具文档说明。既有run不被mute取消。
- 接收、通知、完整呈现、处理完成独立。搜索/局部历史不签发完整target视图；所有分页游标检查actor和当前ACL。
- 历史接口给出范围、截断和缺口，不假称全平台搜索。around-message必须返回命中附近的授权正文；新成员仅访问当前允许的历史。
- 对明确的可执行请求先检查/认领规范消息任务，普通讨论不强制任务树。人类可见任务状态与原始讨论可关联；done是否需要用户确认由具体请求决定，不将所有工作硬编码人工审核。
- reminder归作者，支持有目的的一次/周期唤醒；任务done不隐式取消。后台知识维护可只更新自身，不强迫普通聊天发言；activity记录触发与结果分别呈现。
- 消息freshness门控保留补读/修改/放弃/知情继续；不评价模型质量。平台发送与本地检查之间存在竞态，明确保证范围。

## 6. 配置、迁移与兼容

配置边界把内部Agent定义与平台bindings分开。实验阶段使用显式配置播种，非热增员；AgentDirectory接口按ID查询/列举，runtime不遍历Slack安装列表。后续动态增员复用身份服务，不能只追加一个SDK client冒充生命周期。

迁移采用分步替换，禁止整个仓库同时保留两套事实数据模型：E1先提取可用的核心边界与compatibility facade，E2迁移引用及映射，E3及后续接新能力。每步不得宣称全部解耦。旧Slack形状允许在明确legacy adapter中暂存，核心新接口不新增其依赖。

迁移前独占锁和数据库/工作区备份；逐schema版本事务迁移，失败回滚，不删库。保留message/task/action/outbox身份和unknown语义。旧JSON载荷包括targets、drafts、attention views、deliveries、task intents、schedule anchors、receipts。动作/outbox的原request、request_hash和原receipt作为不可变wire证据保留；尤其request_hash已随Slack metadata发出，严禁迁移时重算。新增版本化canonical引用/映射供应用查询，不建立另一套可写消息事实源。可变状态引用和查询索引统一迁移；不可变证据通过版本化reader解析到canonical引用，不能一边直接读取旧target另一边使用新target而漏掉unknown阻挡。历史journal是已呈现证据，保持不变，旧工具结果/引用通过明确兼容解析解析到映射；旧viewToken失效，重新读取。原未知效果不能因新映射绕过。同action ID重试先按记录的payload版本还原并比较原请求；转换映射不视为参数改变，但内容、目标实体、执行授权的真正变化仍拒绝。旧pending/held保留原wire envelope，派发时从可信映射解析而不重建不同hash；unknown对账比较原wire hash/作者/目标。缺失或冲突映射使迁移失败，不能猜测。备份恢复是回滚方式，不自动降级schema。

E2实现前必须提供实际表/JSON字段清单及迁移fixtures，逐项检查；没有清单不能通过gate。迁移会话工具基线沿用现有受控baseline更换机制，不使原snapshot继续宣称新schema兼容。

## 7. 实验管理与后续扩展

实验版提供本地查询成员/任务/提醒/活动的入口和已有owner暂停/恢复路径；服务返回可供未来web/CLI复用的结构化结果。活动只记录必要事实和对象引用，查询时检查可见性，不集中复制所有私聊与私有memory。内部DM的用户可见投影必须显式配置，不能默认将私有上下文广播。

后续可实现创建提案表单、VPS HTTPS接入、直接SSH笔记本和普通改进Agent。SSH离线失败如实反馈，不创建同步/缓存平台。网页、其他平台、第三方集成和QoL后做。

## 8. 软件工程验收与红队讨论

每个gate除正确性/故障恢复，还检查：依赖方向有自动约束；没有SDK类型污染核心；没有隐藏全局状态/双事实源；职责与命名一致；接口有错误/取消/版本/分页语义；配置与迁移可恢复；测试验证外部行为而非复制实现。对相关大类新增处理器必须分拆，不以文件搬家或interface包装掩盖耦合。架构或可维护性验收阻塞与功能阻塞同等处理。

E0独立review讨论重点：分步迁移是否可执行、内部/外部消息确认语义是否一致、接口是否过宽或过度抽象、实验范围是否偷渡生产功能。审查需指出具体章节、影响和替代方案；修订后复审，结论只保留在会话中。

### E1 可验证的分步依赖范围

E1覆盖conversations、collaboration、coordination、reminders、runtime、budget、policy中的静态import，禁止导入slack/daemon或Slack SDK。原本Slack-normalize移回adapter，不将其原样搬到core；Directory port及附件/成果DTO由应用服务层拥有，daemon仅组装。保留明确legacy payload形状（channel/ts等）至E2迁移，标记为兼容债务，不宣称平台无关模型完成。E1自动检查import依赖，E2额外检查核心schema和行为不依赖平台标识/排序/mention；仅通过import检查不足以通过E2。

## E0讨论修订（已复审）

review_e0_architecture初审提出两项P1：会话权威/echo语义缺失、迁移破坏wire hash；两项P2：mentions契约缺失、runtime→daemon反向依赖。已补authority/binding状态表、原始证据保留与版本化解析、结构化mentions、E1依赖范围和DTO归属。E2必须验证旧unknown message/artifact、旧metadata、同ID重试/变参拒绝、echo先到/投影失败/线程回复与撤权。

复审补充E2硬约束：包含projection在内的外部会话locator只路由一个内部会话，禁止同一Slack频道绑定多个内部私聊。对账只接受持久已开始派发的outbox及可信作者/目标/内容/hash证据；prepared/held不能被伪造metadata直接确认。

### E2a身份边界实现注意

ConfiguredAgents是实验阶段配置播种的只读provider，不是动态成员CRUD。worker/session使用AgentDefinition（id/name/role/model），不含平台绑定。旧部署配置仍由compatibility schema接收；E2b/E2c继续分离该入口。baseline哈希现在只包含内部definition与实际prompt/tool定义；已有R8数据库须用现有离线migrate命令（OLD_CONFIG和NEW_CONFIG可以相同）刷新baseline并保留历史，不能直接修改sessions.config_version绕过迁移。

### E2b迁移方案讨论补充：稳定旧ID而非全量换号

独立架构reviewer review_e0_architecture再次讨论并同意：opaque指核心不解释ID内容，历史值无需全部替换UUID。旧ConversationId可沿用channel值，旧MessageId必须沿用全局messages.key（不能仅用ts）；旧thread本地引用通过(conversationId, legacyLocalRef)在兼容层解析，核心禁止JSON拆key或拼Slack locator。新对象可用UUID。外部locator始终有显式唯一binding，不能因为旧内部ID恰为C...就直接传Slack。

为降低迁移写入风险，稳定的旧引用/wire/journal保留；可重建canonical索引统一覆盖新旧target的unknown阻挡和gate。存储兼容reader集中返回domain消息/目标；不能让业务层各自识别旧Slack或新UUID。核心仍须去除前缀、Slack身份/mention解析、ts排序；迁移适配器提取明确时间和版本次序，不能用迁移插入顺序冒充历史顺序。无根正文的合法线程可建立未加载的identity locator，不虚构正文/ACL。

实施可按E2b1领域引用/binding/兼容索引与迁移，再E2b2应用服务切换/错误分类和平台config拆分分gate。E2b1仅基础设施不会标成语义解耦完成；E2c接适配器并通过非Slack端到端验证才算E2通过。

### E2后续迁移gate调整（独立架构讨论）

review_e0_architecture检查现有SQL后同意合并“领域契约切换”和“canonical可变存储迁移”：继续保留旧thread列会为每个查询增加短寿命反向binding转换。合并gate同时切Messages/Attention/Freshness/任务/提醒/runtime、targets/anchors/deliveries/watch/attention定位和消息版本比较，并包含现有Slack外部通信所需的最小规范输入/输出适配。不能把整个Slack转换留到下一gate，否则Output仍需构造旧NormalMessage。

新写入使用明确版本，旧wire/journal保持原字节；消息正文一份，不复制第二张事实表。旧references迁移根据持久存储版本只运行适用阶段，canonical写入后不能再扫描legacyTarget.parse全表。最低验收：旧库升级两次重开、新规范线程跨任务/提醒/attention、旧unknown与新请求阻挡、旧metadata/附件对账、原wire/journal不变、旧参数重试/真实变参拒绝。

下一独立gate再实现internal原子message/delivery、投影与完整local接入。前gate对internal send明确unsupported，不假造Slack ID。调整减少临时facade，不缩小最终E2范围。

### E2b2c路由落地决策（2026-09-21）

与review_e2b2c_canonical讨论后，v17删除E2b2b过渡canonical_targets镜像：可变对象以所属target JSON为权威、表达式索引供查询；outbox以同一行不可更改的canonical target供路由，原wire/hash/receipt独立保留。迁移和新writer均在同事务写入；DB校验routing引用及不可变性，reader核对wire解释。这样unknown和附件可见性查询不需要每次JS全库扫描，也不会因遗漏索引行而遗漏unknown。旧版本解释仅保留于兼容adapter，旧writer位于测试夹具。新消息与effects使用显式payload版本，不能通过ID前缀猜测。

### E2c1 实现前独立设计复核

review_e2b2c_canonical同意E2c1/c2/c3拆分，全部通过才算E2。c1采用独立InternalMessages提交用例及组合目录：internal发送在无await的事务内最终校验ACL/gate，分配数据库整数顺序，提交message/revision/visibility、先message_work后delivery/delivery_work、固定messageId的sent receipt。内部事务失败全回滚，不制造unknown；external仍走原确认流程。收件人使用自己持续预算，不强制任务树。

DM仅允许当前有效run中的已注册Agent与同伴创建，排序pair唯一。重试不恢复撤销权限；第三人不可借ID读取。新openDM action保存明确internal路由；旧action无此路由仍送原adapter，包括prepared/unknown/succeeded，禁止隐式转换语义。目录和Slack巡检按authority/provider分流，配置拆分留c3但c1就必须接通生产。

本地adapter使用同一消息/attention/工作服务与真正无Slack初始化，可信主机输入只接受已配置human身份和显式成员；不构造假Slack locator。schema18新增内部pair、成员、整数序列和local幂等回执，17→18为显式事务升级。非空旧格式库不能通过local bootstrap跳过adapter迁移。internal artifact和尚未接入的projection在写入前拒绝。review seat的输入隔离/恢复规则继续适用，盲审发言保留held/continue选择。

验收包括反向openDM/重复动作/变参、撤权重试、事务故障注入与重开、真实Supervisor入口可调度、peer发给reviewer及恢复、external unknown回归。此复核是设计通过，非代码gate。

### E2c2 projection 设计补齐

依据review_e2b2c_canonical逐项约束：projection_bindings是conversation_bindings唯一external locator的附属配置（复合FK），不是第二路由表。owner显式`disclose:true`授权向指定外部空间披露未来内容，并指定固定publisher；导入白名单另列且必须符合internal成员资格，不授历史读取权。publisher/locator不可原地变更；binding可停用，派发前及异步权限检查后重新检查binding和publisher权限，unknown只保留原证据对账。

每个canonical message+binding至多一个projection，内部提交同时入队；只投影首次消息快照。源binding导入不会反射回原binding，允许转发其他明确披露binding。导入消息后续编辑/删除在内部按外部revision单调更新；已发布其他副本标记过时而不自动重写，避免把镜像副作用当原消息权威。对本来由内部投影出去的外部副本编辑/删除只记录drift，永远不改internal原文。

projection状态独立于canonical outbox。派发前持久冻结wire payload/hash，重启使用原payload；HTTP/echo共用原子confirm，核验sending/unknown/sent、hash、publisher、locator/root/content并绑定原canonical messageId；冲突拒绝，不写新message/delivery。每个失败在结构化projection查询可见。

默认仅向前。新reply引用binding建立前的旧根时记dependency-held/missing_historical_root，不自动披露旧根或猜顶层。owner可显式创建只含“earlier conversation; content not shared”的根锚点，确认后再派发reply；根正在投影但尚未确认则标waiting_root_receipt；根失败/unknown可见且禁止盲重投。锚点也使用同一confirmation/outbox契约。

导入thread root未映射时，原始已认证事件进入独立持久pending-dependency表，正常ingress标已处理以免堵住批次。已绑定根到来后唤醒重放，重查当前import许可/内部membership；其他输入继续前进。不合格metadata不能冒充confirmation：未绑定的新locator按正常授权输入处理，已是投影副本的locator只记录drift。多App使用external locator+revision去重，源码author/principal由adapter认证上下文映射。

c2按依赖分两个代码gate：c2a核心projection状态/授权/原子排队/confirmed绑定/本地协议故障测试；c2b Slack wire/echo和import/revision/dependency、生产接线与管理入口。c2a未连接的外部projection不能开启为可用功能，c2b通过才完成c2；两个gate都独立红队。这个拆分只缩小审核单位，不删任何最终验收。

### E2c3 配置与适配器生命周期独立设计讨论

review_e2c2b_slack_projection已阅读现config/daemon/migrate/main，认定方向可行并提出以下必要修订，全部采纳，无用户决策分叉：

- 规范配置中mate只持有Agent定义、持续预算和内部owner授权名单；adapters.slack单列workspace、稳定human principal映射及安装binding，允许部分Agent无Slack；adapters.local声明可信human与房间。旧扁平配置只在统一兼容入口转换，持久快照/比较/CLI/迁移都使用同一入口。adapter内部可生成legacy兼容view，runtime不再要求bot字段。
- 身份映射与owner授权分离：旧owner默认映射到已有scoped Slack human principal，撤销owner仍保留映射。Slack command认证workspace/安装后映射raw user，再交核心Controls。旧审计不改写；offline迁移禁止改变已有映射或让映射消失后回退，禁止旧workspace/Agent安装身份重绑或静默移除。新安装可添加。已有workspace新显式映射须保持原默认principal，避免改写先前已观察身份。
- local room按配置一次播种，重启核对identity且不重授撤销membership。变更由显式offline migration对旧/新成员差集应用（只新增成员首次grant，移除成员撤销；相同成员保留当前撤销状态），不隐式删除消息/房间事实。新空库可无Slack；旧载荷仍经原adapter兼容解释。
- 一个Daemon与同一Supervisor/ToolRouter/Store；AdapterLifecycle提供有取消/失败契约的verify/start/poll/flush/close，使用共享stop signal，close幂等，部分启动失败关闭已开连接，最后释放DB/单例锁。核心调度独立于adapter周期网络失败；不将整个旧循环简单搬入adapter，也不建泛型插件框架。
- 把Socket、目录、附件下载及artifact transport一起放到Slack组合边界；保持现有窄能力接口。未绑定Slack的Agent可以内部收发与工作，外部动作明确unavailable，不借用其他Agent安装，也不把旧外部action改为内部。组合目录故障返回内部spaces及external incomplete。
- 本地常驻入口通过同一运行时接收可信主机输入/查询输出与owner控制，不引入HTTP或独立业务状态；已有停止、预算、工具/隔离规则一致。

验收：旧配置等价规范化与两次重启、原wire/hash不变；部分Slack绑定/全local实际运行；owner撤权保持author identity；房间重复启动不恢复权限；网络周期失败不挡内部调度；部分启动/取消释放连接和锁。讨论结论及此记录是c3实现前设计决策，不代表代码已验收。

### E3b implementation design — bounded history and coverage

Proposed application service `ConversationHistory` owns canonical local history/search/around; a narrow `HistorySource` port performs optional bounded platform reads. This supplements existing read/attention APIs rather than silently changing legacy action results. New local query pages have current Agent ACL and message visibility checks, opaque query-bound cursors and explicit `local_visible` coverage; they never issue a freshness viewToken or acknowledge body presentation. Search scans a bounded batch and can return a continuation even when that batch contains no matches. Around returns nearby authorized messages around an authorized anchor, not only the hit.

Internal room history is authoritative locally. Current room membership authorizes historical room reads (independent review seats still cannot read). Explicit history retrieval can expose older messages to a newly added member without creating a new incoming work request or marking them seen/resolved. External history remains constrained by the acting installation's current authenticated platform access; it must not expose messages merely because some other Agent cached them.

`HistorySource` receives canonical target, before/after canonical anchors, bounded limit, cursor and stop signal. Slack owns locator/timestamp translation and transport credentials. It rechecks membership/run/readability after awaits and before transactionally recording the returned page for that actor. Historical acquisition is a separate trusted ingestion mode: persist message/revision and visibility, but do not produce fresh delivery or advance attention seen/resolved. Pending true event delivery remains distinct. Adapter failure/unsupported source is explicit; local content remains accessible.

Remote coverage reports the requested range, returned page, continuation, whether that range was exhausted, and limitations (platform retention/deletions unknown; channel history does not guarantee thread bodies). No claim of complete platform search. Local cursor contents are query metadata, not authorization grants; every page rechecks ACL and review-seat isolation. Data edits/new arrivals may affect live pagination and are reported as such; this is not a snapshot or freshness proof. Provider/canonical cursors cannot be reused under a different actor, target or query. First implementation uses bounded linear scanning for legacy-compatible text matching rather than introducing an unnecessary indexing service.

Before code, discuss the internal-current-membership history contract, quiet history acquisition and coverage semantics with independent red team; this extends the E0 design with concrete read contracts rather than introducing a new product subsystem.

E3b独立设计复核（review_e3a_participation）通过方向，以下为实现前接受的约束：quiet path不得写message_observations或迁移/清除attention_seen，不得创建delivery或改变resolved；event-first/history-first、编辑版本和重复页均需回归。新revision/新visibility仍写conversation events使旧view失效。外部新visibility只对应acting installation实际返回的版本与正文快照；远端页落后于全局缓存时仍保存该installation实际返回的旧revision，但不回退共享current。同一provider revision的附件展开等正文差异也隔离在actor snapshot中，不能覆盖另一installation的读取或freshness；历史revision证据行不可变。内部完整历史授权限于当前可访问的internal channel；DM保留原pair/member边界。cursor绑定actor、target、operation、query、范围、排序，使用精确(order,messageId)边界；空搜索批次仍可继续。remote port明确携带RunToken，所有await之后重查run/ACL/review隔离再事务提交。来源范围exhausted不代表全平台完整；过滤/导入失败、缺根、缺cursor必须报告gap。上述是工程契约，不需要用户作产品裁决；现在可实施E3b。

### E3b 实现复审结论

review_e3b_history最终PASS。v21将external visibility升级为每Agent的revision+完整body snapshot，避免不同Slack installation的新版、删除或同revision附件展开互相覆盖；共享current只用于canonical最新缓存，不能作为actor读取授权。quiet fetch只更新证据与actor freshness，不制造observation/delivery/seen/unseen。v20缺少actor-specific body，迁移只能以最高observation对应revision body回填、无observation时采用current snapshot并写audit；旧same-revision变体无法还原，这是历史证据上限而非运行时静默猜测。

历史查询必须适合低配VPS：target/thread查询强制expression index；无target搜索按`channel_access`稳定顺序逐频道走索引，总raw scan budget为1001，不进行跨频道临时排序。旧`messages.search/recent`也直接按actor snapshot筛选，不能先把所有key物化到JS。坏远端条目以嵌套savepoint隔离并形成gap，不能回滚同页正常条目；provider exhaustion与导入gap分别表达。

### E4 实现前设计 — 协作恢复、owner activity 与工具组合

E4首先补协作信息的可恢复读取，并修复当前task状态变化与event不一致的问题。`TaskBoard`是conversation/coordination之上的应用查询服务：`list(actor,{relation,status,target,cursor,limit})`、`read(actor,taskId)`、`events(actor,taskId,cursor,limit)`均返回稳定DTO与不透明游标；游标绑定actor、relation、status、target、limit与`rowid/id DESC`排序，每页重查当前权限并完全拒绝review-seat。relation精确定义为：`owned`是owner=actor（可由status过滤含terminal）；`assigned`是assignedTo=actor且owner不是actor，包含尚未发布draft但不因此允许执行；`available`仅含owner为空、status为todo或review、且assignedTo为空或等于actor；`all-visible`含其他当前可读任务，但别人的draft不可见。列出不等于claim，assigned-to-other永不出现在available，普通消息协作也不要求任务。

任务新增nullable持久`createdBy`。迁移只按可证明来源依次回填：create event中的唯一agent、draft outbox actor、assigned actor；无法证明时保留null/unknown，绝不能把迁移执行者当creator。内部message-task按当前internal channel成员读取；external message-task除conversation ACL外必须能通过`Conversations.message(actor,messageId)`读取该Agent自己的installation snapshot，避免title/result绕过E3b。未绑定message的legacy task带`legacy:true`与coverage gap，仅按当前target ACL兼容读取；尚未发布的draft只对已证明的createdBy/assigned actor可见，两者都未知时对Agent fail closed、仅owner控制面可诊断。TaskBoard按relation、target和事件分页建立明确索引，并用实际production SQL `EXPLAIN`拒绝全表/临时排序；超过100条任务、稀疏relation及旧事件也必须有continuation。

task写入仍以canonical message为锚，CAS version和freshness intent保持现有单一入口，但所有改变status、owner、assigned、waiting、message binding或version的路径必须经一个transactional transition API，同时追加结构化`{from,to,version,actor|cause}`事件。每个可观察变化递增version，幂等重复不变化也不追加。范围包括普通claim/update/unclaim/transfer/wait、dependency自动恢复、draft创建/可见发布/投递失败和work取消；不得再由`MessageTasks`或owner control直接更新行并各自拼event。迁移为每个旧task保存event baseline version并追加`migration_snapshot`，只承诺baseline之后完整；query返回`coverage:{completeAfterVersion,historicalComplete}`，绝不伪造旧历史。事务故障必须同时回滚task与event。

普通peer review不是独立盲审：owner为空的`review`任务可以被claim且保持review；review中的unclaim保持review；transfer必须显式选择`preserve_review`或`return_for_changes`，前者把review交给同伴，后者把doing交回实施者。并发仍以expectedVersion仲裁。验收覆盖实施者提交review、同伴接手、退回修改、再次提交、完成和CAS冲突。正式blind review仍走review seat并禁止TaskBoard。直接讨论、帮助和交接仍不要求建立任务树。

Reminder继续作者私有，不因task完成自动取消。新建/编辑明确选择`projection: private | conversation_receipt`，默认private；旧记录迁移为conversation_receipt以保留历史行为。scheduler到期只形成author delivery与`fired` firing，delivery payload必须显式携带`firingId`；private不创建outbox、conversation event或同伴attention，conversation_receipt才产生无正文的固定system receipt。Agent处理该delivery后可用幂等`reminders.finish(firingId,status,summary?)`记录实际`completed | failed | deferred`结果；必须核验作者与该author-owned firing，重复同值返回原结果、变参拒绝，summary只在作者私有log中可见。`deferred`只描述本次处理结果，不创建下一次wakeup；需要再唤醒时必须另行edit/create，返回值和prompt都明确这一点。scheduler fired、delivery/run transport状态、公开receipt状态和Agent声明result分别展示，不能把“触发过”或“run complete”冒充语义完成。事件与firing是两条序列，API返回`eventCursor`和`firingCursor`，各自稳定分页并重查当前ACL；低配查询有对应索引/plan测试。Supervisor recovery使用TaskBoard的分类摘要与coverage/continuation，不再从旧`c.list()`取前100再截20。

Owner观察采用平台无关的`OperationsView`，而不是让Slack controller、未来网页和local入口各写SQL。该service自身验证canonical owner principal，不依赖adapter先验。`status(owner)`直接读取权威表，给出Agent暂停/active run、budget/work、unknown action/output、held draft与due reminder的ID、状态、计数和安全reference；不返回raw action/outbox request、receipt、run error、reminder content、result、路径或正文。Controls改为调用它，local入口返回同一结构化DTO，Slack formatter只负责呈现。

`activity(owner,cursor,filters)`优先合并已完整化的task events、reminder events/firings以及runs/actions/outbox的安全状态投影，不为这些领域再双写统一journal。cursor是包含各source watermark的查询绑定向量；结果按`at/source/sourceId`稳定合并，并返回每source coverage/gap，绝不暗示迁移前完整。只为没有权威事件来源的少数事实（首期仅internal DM元数据和缺少转换事件的runtime lifecycle）增加窄`operational_facts(source,sourceId)`，唯一键保证幂等；fact只含时间、枚举kind、actor、subject/target reference和安全计数，不复制消息/DM正文、参与者名单、reminder content、result/summary正文、私有memory、工具参数、文件路径、secret或模型输出。fact是对应操作成功契约的一部分，插入失败有意回滚同事务；迁移不伪造旧事实，故障注入验证回滚与唯一键重放。

activity读取只允许owner控制面，Agent工具和review seat都不可达。读取或写operational fact本身不产生delivery/conversation event，也不唤醒Agent。未来Slack保留频道或web app只能通过显式adapter投影category allowlist；adapter还要选择公开级别，默认DM只显示“发生内部协作”而不披露参与者或conversation id。核心不认识频道名，不默认创建或发送保留频道。

ToolRouter在E4c收敛为少量组合规则与内建领域`ToolModule`，先提取conversation/history、coordination/reminder、session/status等现有边界；broker执行与output gate仍复用原受控服务，不做任意第三方插件加载。具体注册必须使用不可缺字段的判别联合：schema、description、`workPolicy:none|current|task|reminder|select|broker-managed`、`seatPolicy:deny|redacted-read|clean-workspace|held-send`、`effectPolicy:pure-read|atomic-recorded|broker-recorded|adapter-recorded`、`replayPolicy:immutable|refreshable|boundary-owned`、参数授权器、post-await fence和handler全部必填；重复、保留`tools.*`、缺失或未知组合在启动时fail closed。Router仍唯一注入actor/run/work/actionId并执行二次Zod解析；中央executor消费这些策略，handler不能自报actor或自行跳过。atomic-recorded继续使用原operation+args持久request并让local mutation+action settle同事务；adapter/broker已有receipt边界不套第二层action。测试枚举每个公开operation恰好一个spec，并逐类验证同ID同旧request replay、变参冲突、executing/unknown不重放、stop/revoke await fence、seat的direct/tools.call/list/describe一致、work/budget与文档顺序稳定；prompt/tool变化仍触发显式session config migration。现有operation名称和持久request必须继续可解释，重构不借机改变产品语义。

设计红队必须重点反驳：任务列表是否仍会遗失旧承诺；自动/批量task transition是否都有event；peer review是否可接手而不伪装blind review；external task是否绕过actor snapshot；private reminder是否真不发频道且result不与fired混同；activity是否成为敏感内容副本或第二份状态；同事务fact失败与回滚是否明确；系统activity是否可能形成Agent回复循环；handler元数据是否出现默认放行；模块边界是否增加抽象却没有减少ToolRouter耦合。上述均是工程选择，不要求用户决定新的工作流。
