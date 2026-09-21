# Mate 实验版架构设计

状态：E0 独立红队讨论及复审 PASS，2026-09-21。本文为目标设计，不声明代码已经符合。取代旧设计对 Slack 为核心实体、静态团队、固定协作流程的假设。保留 pnpm、Pi Core + pi-ai、SQLite、单 daemon、每 Agent 单主 run。

## 1. 目标与阶段

实验版验证足够智能的模型在工具、环境和 prompt 下可达的行为。预配置少量成员即可，不需要先完成 Slack App 自动创建、生产 VPS、SSH 配置或网页。内部设计支持后续动态成员、CLI/web/其他通信适配器。核心体验包括持续身份、自主注意力、直接协作、可检索历史、认领/交付、提醒、真实工具和人类介入。

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
| execution | grants、回执、取消、隔离执行 | Store、明确的actor/run/work上下文 | 把消息门控当命令审核 |
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

日常版再实现创建提案表单、Slack安装绑定、VPS HTTPS接入、直接SSH笔记本和普通改进Agent。SSH离线失败如实反馈，不创建同步/缓存平台。网页、其他平台、第三方集成和QoL后做。

## 8. 软件工程验收与红队讨论

每个gate除正确性/故障恢复，还检查：依赖方向有自动约束；没有SDK类型污染核心；没有隐藏全局状态/双事实源；职责与命名一致；接口有错误/取消/版本/分页语义；配置与迁移可恢复；测试验证外部行为而非复制实现。对相关大类新增处理器必须分拆，不以文件搬家或interface包装掩盖耦合。架构或可维护性验收阻塞与功能阻塞同等处理。

E0独立review讨论重点：分步迁移是否可执行、内部/外部消息确认语义是否一致、接口是否过宽或过度抽象、实验范围是否偷渡生产功能。审查需指出具体章节、影响和替代方案；修订后复审，结论写入reviews/E0-architecture.md。

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

## V0 首版部署架构复核（用户新标准，独立复审PASS）

首版包含Linux VPS部署准备和Agent沙盒隔离。沿用一个可信daemon+SQLite，每Agent独立session/workspace，工具经broker与ExecutionBackend，不向模型暴露宿主或Docker socket。复用已有Docker命令沙盒（每次执行短生命周期、只挂载授权workspace、资源上限、清理PID namespace），文件操作的Linux隔离实现需要实际验证。daemon是可信控制面，应使用专用非root账户；Docker管理权限仅给控制面，不传进Agent执行环境。

首版默认Socket Mode沿用现有Slack接线，不强制新增公网入站服务；HTTPS入口作为后续adapter选择，不阻止以后改传输。配置/secret引用从环境输入，不写入镜像。dataDir独立于代码发布目录，备份包括DB和Agent私有文件。服务重启先取得单实例锁、回收所属孤儿执行、恢复持久队列；失败不得退回宿主直接执行。

低配置VPS需可配置全局模型run/执行并发与每次执行资源，预算/恢复语义保持。部署必须给出固定版本依赖、服务启动方式、可重复安装/诊断、升级回滚及停止操作。优先宿主systemd管理可信daemon、Docker只承载Agent命令，避免daemon容器内管理宿主路径的额外映射复杂度。开发验证可在本机Linux VM/容器内进行，但不假称真实VPS已验。

独立review应检验隔离边界、低配资源、可维护部署和最小接入；不把当前macOS隔离结果当Linux证据，也不以模型聪明程度作为阻塞。

### V0红队修订：首版部署契约

- 支持目标固定为Ubuntu 24.04 LTS x86_64、Node24、Docker Engine及systemd；其他发行版/架构不冒充已验。Linux结构化文件操作优先使用同一受控Docker环境内的固定文件helper，宿主SRT保留为已验证macOS开发后端。共享operation schema与Broker回执，不新建权限/动作状态机。启动前实际探针检查读写、越界拒绝及命令namespace清理；探针失败不接Slack、不消费模型run。
- 首版默认全局1个active run、1个exec admission，可配置；等待admission时可取消，采用轮转公平调度。结束run后关闭或有限TTL淘汰worker，重建从持久context恢复。容器memory/cpu/pids可配置，必须处理OOM/ENOSPC并释放资源。workspace使用部署层硬容量边界：安装时为每个Agent建立可配置容量的独立ext4 loopback文件系统（默认512MiB），预留控制面DB空间；运行时水位只补充诊断，不代替容量界限。外部grants由owner配置其容量边界并在部署清单明确，不默认授权整宿主目录。
- namespace删除未确认时，ExecutionBackend熔断新的沙盒执行，Broker保留unknown回执；daemon进入退出/重启恢复路径，不把抛错当作已终止。shutdown使用finally关闭连接并释放锁；systemd超时强杀不等于Docker进程已清除，下次启动取得单实例锁后先清理所属scope，无法确认则不调度。测试Docker不可用、强杀、停止中排队及不触及其他scope。
- 备份首版采用停止daemon后的离线一致备份；安全复制symlink本体而不跟随，不允许链接扩大备份范围，特殊文件明确失败。清单标明纳入dataDir数据库/Agent内容、排除外部grant roots并列出路径，以及配置/镜像标识；secrets需要独立重新提供。原绝对路径恢复是首版明确限制。loopback容量容器由安装层重建，备份包含其挂载内容而非重复复制磁盘文件；恢复前核验容量和挂载点。验收失败残留、损坏、完成标记、同路径干净VM恢复及升级回滚。
- V1执行隔离必须用真实Linux kernel、明确Docker daemon与bind mount所在宿主，不使用特权嵌套容器冒充默认环境。V2用能运行systemd的干净Linux VM或等价真实系统，按手册安装；记录kernel/distro/UID/Node/Docker/image。Docker binary测试改为可配置。Linux VM是可在本地完成的验证目标，不要求获得用户VPS凭证才开发。
- 信任边界：daemon、Pi worker、固定helper代码属于可信控制面；Pi worker持有provider key，模型输入与任意exec不可信。被沙盒隔离的是Agent工具执行及私有workspace访问，不宣称防御SDK/可信worker代码本身被攻破。专用非root用户不是Docker管理权限的安全边界；拒绝给Agent挂载Docker socket、daemon状态、凭证目录或其他Agent私有root。模型不能通过工具参数变更这些挂载。

这些修订是普通工程决策，没有需要用户裁决的产品分叉。V1/V2独立审核必须验证上述契约；V0设计通过不等于Linux已经验证。

V0复审补充：loopback磁盘文件必须实际预分配宿主空间；启动/恢复检查mount身份、容量，挂载失败不回退普通目录。文件helper共用Docker资源限制/清理熔断，不继承宿主env，不从可写workspace加载代码。恢复拒绝部分/损坏备份，先确认目标mount再恢复，不跟随symlink。review_v0_deployment仅设计PASS，执行验证属于V1/V2。

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
