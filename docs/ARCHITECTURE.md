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

- 支持目标固定为已经实际验收的Debian 13 x86_64、Node24、Docker及systemd；其他发行版/架构不冒充已验。Linux结构化文件操作优先使用同一受控Docker环境内的固定文件helper，宿主SRT保留为已验证macOS开发后端。共享operation schema与Broker回执，不新建权限/动作状态机。启动前实际探针检查读写、越界拒绝及命令namespace清理；探针失败不接Slack、不消费模型run。
- 首版默认全局1个active run、1个exec admission，可配置；等待admission时可取消，采用轮转公平调度。结束run后关闭或有限TTL淘汰worker，重建从持久context恢复。容器memory/cpu/pids可配置，必须处理OOM/ENOSPC并释放资源。workspace使用部署层硬容量边界：安装时为每个Agent建立可配置容量的独立ext4 loopback文件系统（默认512MiB），预留控制面DB空间；运行时水位只补充诊断，不代替容量界限。外部grants由owner配置其容量边界并在部署清单明确，不默认授权整宿主目录。
- namespace删除未确认时，ExecutionBackend熔断新的沙盒执行，Broker保留unknown回执；daemon进入退出/重启恢复路径，不把抛错当作已终止。shutdown使用finally关闭连接并释放锁；systemd超时强杀不等于Docker进程已清除，下次启动取得单实例锁后先清理所属scope，无法确认则不调度。测试Docker不可用、强杀、停止中排队及不触及其他scope。
- 备份首版采用停止daemon后的离线一致备份；安全复制symlink本体而不跟随，不允许链接扩大备份范围，特殊文件明确失败。清单标明纳入dataDir数据库/Agent内容、排除外部grant roots并列出路径，以及配置/镜像标识；secrets需要独立重新提供。原绝对路径恢复是首版明确限制。loopback容量容器由安装层重建，备份包含其挂载内容而非重复复制磁盘文件；恢复前核验容量和挂载点。验收失败残留、损坏、完成标记、同路径干净VM恢复及升级回滚。
- V1执行隔离必须用真实Linux kernel、明确Docker daemon与bind mount所在宿主，不使用特权嵌套容器冒充默认环境。V2在能运行systemd的实际目标机按手册安装；记录kernel/distro/UID/Node/Docker/image。Docker binary测试可配置，虚拟机只作为可选开发环境，不能代替目标机验收。
- 信任边界：daemon、Pi worker、固定helper代码属于可信控制面；Pi worker持有provider key，模型输入与任意exec不可信。被沙盒隔离的是Agent工具执行及私有workspace访问，不宣称防御SDK/可信worker代码本身被攻破。专用非root用户不是Docker管理权限的安全边界；拒绝给Agent挂载Docker socket、daemon状态、凭证目录或其他Agent私有root。模型不能通过工具参数变更这些挂载。

这些修订是普通工程决策，没有需要用户裁决的产品分叉。V1/V2独立审核必须验证上述契约；V0设计通过不等于Linux已经验证。

V0复审补充：loopback磁盘文件必须实际预分配宿主空间；启动/恢复检查mount身份、容量，挂载失败不回退普通目录。文件helper共用Docker资源限制/清理熔断，不继承宿主env，不从可写workspace加载代码。恢复拒绝部分/损坏备份，先确认目标mount再恢复，不跟随symlink。review_v0_deployment仅设计PASS，执行验证属于V1/V2。

### V2目标机部署架构（独立设计复核PASS）

V1已经在实际目标机`ncDE`验证；首个受支持并实际验收的生产基线因此改为Debian 13 x86_64、Node 24、pnpm 10、Debian Docker 26与systemd 257。Ubuntu 24.04保留为可能兼容的平台，但没有完成同等级安装验收前不能列为已支持。平台判断仍以所需能力为准，部署包只对明确验收的发行版/版本组合承诺支持，不把“Linux”当成无限兼容声明。

部署资源分成五层，彼此不交叉写入：不可变release位于`/opt/mate/releases/<release-id>`；规范配置、workspace manifest与环境引用位于`/etc/mate`；SQLite、部署/恢复journal与mountpoint位于`/var/lib/mate`；root拥有且daemon只读可见的预分配backing位于`/var/lib/mate-volumes`；systemd unit位于`/etc/systemd/system`。`release-id`由git commit、pnpm lockfile、构建产物与安装依赖inventory的摘要共同确定，release内保存身份manifest并由root拥有、移除组/其他写权限，不能用git SHA冒充不同构建完全相同。`/opt/mate/current`只在候选构建、普通测试、目标平台container profile都通过后切换。升级保留一个已通过的回滚release。代码、可变数据、secret和backing不放在同一目录，也不从release目录加载运行数据。

首版提供版本库内、可审计且幂等的Debian host安装入口与systemd模板，不依赖Ansible、Kubernetes或额外部署框架。它必须先给出plan/preflight，再创建资源；plan同时报告两个release、Docker image、全部backing的磁盘需求、预留控制面空间和daemon/container并发内存上界。部署spec为每个私有Agent给出容量（未写时默认512 MiB），并按唯一canonical external root给出一次容量/backing；多位Agent可分别获授同一个external root，plan对grants规范化后验证每条均被该唯一root覆盖。存在未覆盖external root、额外spec entry、嵌套或重复canonical root时失败，不能把普通宿主目录写进manifest。现有Agent身份首版只能保留或新增，不能删除/重绑；grant可按现有显式migration规则增删。

安装先检查总空间和最低state预留，再在`/var/lib/mate-volumes`同目录的root-owned transaction staging中按`truncate → mkfs.ext4 → fallocate`创建backing，验证完整allocation、filesystem和容量后才原子rename到最终路径。unit/config/manifest/release identity同样先写同目录临时文件、fsync并rename；安装journal记录本次创建的staging，重试只清理身份匹配的本次残留，不把任意“不一致”文件当作可删除临时物。已有最终资源只有在owner、mode、容量、filesystem、unit内容和配置身份完全相符时可复用，任何不一致均停止，不自动格式化、覆盖或缩容。

每个唯一受管root对应一个由`systemd-escape --path`确定名字的`.mount` unit，挂载选项固定为`loop,rw,nodev,nosuid`。初次格式化后临时挂载并把ext4根设为`mate:mate 0700`，再正常卸载；`/var/lib/mate-volumes`为`root:mate 0710`以允许daemon解析/stat最终backing，文件为`root:root 0600`且daemon不能修改。配置、env与manifest为`root:mate 0640`。`mate.service`对Docker和全部mount同时声明`Requires`/`After`（并使用`RequiresMountsFor`复核路径），采用`UMask=0077`、`NoNewPrivileges`、`PrivateTmp`、`ProtectHome`、只读系统目录和仅`/var/lib/mate`可写。安装不会在secret/config尚未通过检查时自动启动服务。

可信daemon使用无交互登录的专用`mate`账户。目标机的系统Docker socket由root与`docker`组控制；首版systemd unit通过显式`SupplementaryGroups=docker`只给该服务进程Docker控制能力，不修改Agent容器身份，也不把socket挂入Agent workspace。该能力等同root级主机控制，只属于既有可信控制面，不被描述为daemon自身的安全边界；rootless Docker会增加常驻daemon、网络与存储差异，暂不作为低配置单人VPS的首版默认。真正写入该授权是独立、可见的部署动作，必须在unit和plan中明确显示。

运维检查拆成两个正式接口。`doctor`是被动、可并发诊断：只解析配置/环境引用，检查版本、release身份、image存在、socket可访问、路径分层、manifest/mount/capacity/owner和服务状态；不取得scope、不删容器、不写nonce、不连接Slack/模型、不创建DB、不拉镜像。`offline-probe`必须在service停止后取得同一daemon lock，才可执行scope recover和全部root双向probe。两者以及backup/migrate/restore都由root-owned allowlist wrapper通过`systemd-run --wait --pipe`以`User=mate`、`Group=mate`、`SupplementaryGroups=docker`和主service的基础hardening运行；backup/restore one-shot额外只读写固定checkpoint root`/var/backups/mate`，主service没有该写权限。wrapper只接受规范化后位于该root的checkpoint目录，拒绝路径穿越、任意命令/property/env注入和直接root执行；改变状态的操作发现主service active即失败。这样离线命令与daemon使用同一UID/GID和Docker权限，不要求把`mate`永久加入docker组。

备份格式升级为带完整inventory的version 2：记录原dataDir、规范配置摘要、Agent集合、数据库与每个私有workspace条目的规范相对路径、类型、逻辑/allocated大小、mode、内容hash或symlink目标；完成标记最后原子写入。备份不跟随symlink并防止检查后换入，拒绝socket/device/FIFO等特殊文件，固定排除ext4根的`lost+found`和`/var/lib/mate/control`中的deployment/restore journal，排除所有external grant与backing image。外部root在backup/restore只验证manifest身份与容量，绝不检查为空、复制或清理其用户资料。固定checkpoint父目录为`/var/backups/mate`（`root:mate 0750`）；root wrapper预建唯一、规范化的`mate:mate 0700`目标后运行backup。backup完成并fsync后，wrapper以nofollow遍历复核inventory，把目录/普通文件分别封存为`root:mate 0750/0640`并lchown symlink本体，使maintenance身份只读；主service不能写该路径。restore journal锁定checkpoint目录inode、COMPLETE/inventory hash，wrapper在journal存在时拒绝替换/删除该checkpoint，每项复制通过`O_NOFOLLOW` fd在复制前后核对identity与hash。检测到decision后源损坏时保持journal和daemon阻断，修复同一封存checkpoint后才可续作，不能换源猜测成功。旧version 1 checkpoint继续支持原先“dataDir必须不存在”的unmanaged恢复，不静默按新语义解释。

managed restore同时支持初始化空目标和显式replace已有状态，但不要求硬容量workspace同时容纳old+new两份。replace非空目标前必须先生成并完整验证当前状态checkpoint；目标checkpoint也必须完整、不可变，并在decision前根据inventory allocated blocks、entry开销和目标`statfs`作保守容量证明，不能适配则不改目标。restore在`/var/lib/mate/control`持久化、逐次fsync并原子替换journal；Daemon在打开SQLite前发现未完成journal一律拒绝启动。decision前只验证两个checkpoint、manifest、private容量/mount和恢复计划，不改变DB/workspace；原子decision之后进入只能roll-forward的阶段：逐root清除除`lost+found`外的private内容，从目标checkpoint以单文件同目录临时写、fsync、hash复核、rename的可重入方式恢复，并记录完成项，数据库最后替换。崩溃后同一命令依据inventory校验已完成项并继续，不能切回旧daemon；全部完成后才移除journal。若要回到旧状态，先完成本次roll-forward，再以预先生成的旧checkpoint发起新的replace。初始化空目标使用同一协议但不要求旧checkpoint。V2b必须在接近ENOSPC的真实ext4上验证decision前无修改与decision后崩溃续作。

配置/release升级使用`/var/lib/mate/control`中的独立deployment journal，解决数据库迁移与`/etc`配置、`current` symlink不能同事务提交的问题。V2首版只自动化mount topology不变的升级：Agent ID集合、private root、规范化external root集合必须完全相同；新增Agent或增删grant/mount的部署变更留给后续独立设计，installer/migrate wrapper明确拒绝，不能因底层配置schema允许就声称可运维。流程固定为停service、创建并封存checkpoint、验证不可变新release和staged config、写journal、以staged old/new config运行offline migration、原子切换config与current，再进入非活动`candidate`阶段。candidate只允许被动doctor、offline-probe和不调用`Daemon.start()`的构造/数据库兼容检查；禁止连接Slack/provider、ACK/导入事件、启动调度、派发outbox或执行Agent run，因此这一阶段可停机跨重启并安全恢复旧config/current与checkpoint。

`matectl activate`是外部副作用边界：它在service仍停止时原子把journal置为`activated`，从该点起禁止checkpoint状态回滚，然后才允许正常`Daemon.start()`接入Slack和调度。activated启动失败只能fix-forward，或在兼容性manifest明确证明旧代码可读取当前DB/config时做保留当前状态的code-only rollback；不能恢复旧checkpoint。owner确认正常后finalize移除deployment journal。checkpoint不能回滚Slack/provider世界，人工灾难恢复必须单独对外部副作用和unknown receipt做对账，不能作为自动升级rollback。任何release变更即使配置未变也先checkpoint，因为候选构造可能升级数据库schema；只有明确证明DB/config格式均未变化的已知版本才允许优化掉checkpoint，不能仅凭启动失败猜测。

部署入口只提供非破坏性的重复安装、验证和显式停用：停用先停止service并确认其scope无残留容器，再正常卸载全部受管mount；任一mount为EBUSY即失败，不使用lazy/detach，并保留`/var/lib/mate`、backing与checkpoint。删除backing或状态没有自动命令，必须由owner在独立备份后手工处理。V2首版的managed topology固定；动态新增Agent和grant mount需要后续扩展deployment transaction，不能热改unit或manifest。

systemd停止、离线backup/restore、doctor/offline-probe、升级candidate/commit/rollback和启动顺序写入runbook并在目标机实际演练。Socket Mode仍是首版Slack传输，不新增域名或HTTPS入口；runbook明确每个Agent对应的Slack App binding、app-level `connections:write`、Event Subscriptions、slash command、bot scopes，以及只需出站443/WebSocket。真实token、workspace/App/channel ID由用户接入，缺失时不阻塞上述部署和本地adapter验收。

独立只读红队`/root/review_v2_architecture`经过四轮复审后判定V2a PASS。实现期保留四项P2验收要求：checkpoint封存必须fsync所有修改过metadata的目录及checkpoint父目录，symlink使用lstat/readlink语义；release identity inventory必须落实target arch、精确Node/ABI与native addon hash；decision后checkpoint repair只能由root控制且保持journal绑定的source identity；activate后失败必须保留activated journal供重复诊断和fix-forward，不能被通用cleanup删除。

V2b实现把格式、备份与恢复拆成三个边界：`checkpoint-format`只负责严格manifest、流式inventory/copy、完整payload验证、root sealing和失败目录identity cleanup；`backup`只从已静止的Store与私有root构建一个没有提前完成标记的checkpoint；`restore`只执行Linux managed mount上的持久decision/roll-forward。部署wrapper尚属V2c，但它已经有明确可调用接口：预建唯一service-owned空目录，backup子进程退出后调用root-only seal；失败时只用预先捕获的device/inode清理无`COMPLETE.json`目录。CLI只暴露seal，不暴露任意root命令。

恢复的文件路径防护使用`O_NOFOLLOW`打开普通文件，并在复制前后复核源/目标父目录identity与canonical path。它不是对同UID恶意并发写者的完整内核级防护；受管契约先停service、取得daemon lock、验证Docker control isolation并recover同一execution scope，root封存source且root控制checkpoint父目录，从而排除Mate可启动的同UID写者。V2c wrapper/systemd必须保持这个前提，不能在restore期间另起mate进程。真实Debian验证使用三个独立64 MiB ext4 mount，覆盖接近ENOSPC的decision前拒绝、第一Agent完成后的实际SIGKILL、SQLite最后替换、源篡改后同identity修复续作和external不触碰。

现有`migrateConfiguration`继续服务unmanaged开发/兼容环境。只要OLD或NEW配置带workspace manifest就直接拒绝，避免在root封存前先生成普通service-owned备份再修改数据库。managed candidate升级与固定topology检查由V2d部署journal统一编排；在该入口完成前，不存在可误用的“半套生产迁移”。

V2c把初装部署落实为固定Debian模块，而不是通用资源编排框架。strict deployment spec只允许release/config来源、private容量override、唯一external root容量、state预留和daemon内存；用户不能指定service账户、系统路径、unit名或backing路径。纯plan规范化配置grants并报告两份release、全部backing、state和daemon/container并发上界。installer使用`/var/lib/.mate-install-v1.json` bootstrap journal先记录固定目录意图，control目录建立后原子移入；目录、release staging和backing逐项绑定device/inode与状态，只有同identity重跑可续作。release身份覆盖commit、lockfile、dist、实际pnpm运行依赖、Node/ABI和native addon；相对symlink不得逃逸，hardlink计数必须全部闭合在release树内。

systemd单位由确定性renderer生成，mount名只取真实`systemd-escape --path`结果。主服务与maintenance one-shot都用mate UID/GID、临时docker supplementary group、固定environment、`ProtectSystem`等hardening；在该namespace里`ReadWritePaths=/var/lib/mate`会形成与原ext4/loop完全等价的重复mount layer，验证器只在root/source/device/backing/必需options全部一致时接受，任何冲突叠挂仍失败。root-owned `matectl`只把简单checkpoint名称映射到固定根和固定命令，不透传property/env/config/executable。doctor保持被动；offline-probe和disable使用daemon lock、scope recover及双向probe。初装完成前service不连接任何adapter，完成后仍disabled/inactive；升级事务继续留给V2d。

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

历史查询必须适合低配VPS：target/thread查询强制expression index；无target搜索按`channel_access`稳定顺序逐频道走索引，总raw scan budget为1001，不进行跨频道临时排序。旧`messages.search/recent`也直接按actor snapshot筛选，不能先把所有key物化到JS。坏远端条目以嵌套savepoint隔离并形成gap，不能回滚同页正常条目；provider exhaustion与导入gap分别表达。完整记录见`reviews/E3b-history.md`。

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

### E5 实现前设计 — 当前能力发现与工作成果闭环

E5不再把静态工具目录当成实际可用能力。工具目录回答“协议支持哪些操作”，`environment.info`回答“这个Agent在当前work此刻能用哪些资源”。新增平台无关的`EnvironmentCapabilities`应用服务；daemon只把部署profile交给它，ToolRouter只传可信`RunToken`和解析后的current work。返回版本化`mate.environment.v1` DTO，包含当前work ID、每个仍有效grant的opaque ID、稳定可读label、kind、operations、expiry和单次操作挂载点`/workspace`；以及结构化execution、network、known-URL research、attachment input、artifact output状态与限制。DTO不得包含宿主root、socket、token、环境变量值或adapter私有客户端。

配置的额外workspace可有同一Agent内唯一、规范化为小写ASCII标识的可读`label`；`private-workspace`及`private-`保留前缀只属于Agent私有空间。没有显式label的兼容配置以`agentId + canonical root`的单向摘要生成稳定`workspace-<digest>` label，绝不按数组序号生成，也不回传root。同一Agent的canonical root重复时只形成一个profile与一个持久grant：operations取并集；零个显式label使用摘要label；恰好一个显式label采用该label；两个不同显式label则拒绝。不同canonical root使用相同显式label或保留label同样拒绝。上述规范化在daemon启动和offline migration共用一个纯函数，不能由`ensureGrants`遍历顺序决定。

旧version 2配置仍可读，缺label不改变其序列化形状或旧runtime policy hash；环境展示时才计算compatibility label。新增/重命名label会改变规范配置与runtime policy hash，必须走现有显式离线迁移。重命名只改变安全展示profile，不更新grant ID、root、action request或历史receipt。若旧配置含重复root，迁移前profile按上述确定规则解释；下一配置可以显式合并成一项，权限并集变化由现有迁移更新有效grant且不复活撤销/过期grant。label只帮助选择grant，不参与授权。

grant provisioning与能力读取严格分离。新增`WorkspaceAccess`应用服务：Supervisor在把一次run交给模型前，原子地保证该actor/work的配置grant不变量；`works.select`在同一持久action事务中完成选择与provision。其它入口不得靠`environment.info`补授权。被owner撤销或已过期的同root grant不会被provision复活，配置改变仍只经离线迁移。`environment.info`改用current-work policy并保持pure-read，只查询已经存在的有效grant；缺失grant被如实报告为unavailable/configuration drift，而不是写库。

Broker继续以持久grant、actor、work、root、operation、expiry、当前conversation ACL、run状态和review seat为唯一授权事实。Broker提供内部只读`effectiveGrants(run,workId)`，与执行路径共用同一个scope/effectiveness判定；`EnvironmentCapabilities`只能把这个结果映射为安全DTO，不能复制SQL或重新实现expiry/revoke/work/ACL/root/seat策略。能力服务每次查询当前数据库，不缓存授权；撤销、过期、work切换和review-seat切换立即反映，旧报告不是capability token，执行仍重新授权。多个grant分别在一次broker action中映射到容器内`/workspace`，报告必须明确它们不是同时挂载的宿主路径。DTO把文件工具和`exec.cwd`的公开路径规则写成`pathStyle: relative_to_grant`；`/workspace`只作为exec进程内部看到的mountPoint，不能作为file工具参数或`exec.cwd`的绝对路径。

availability按actor与当前work计算，而不是仅看全局配置：没有有效exec grant时即使配置Docker也报告execution unavailable；没有Docker时仍可使用受控结构化file能力。network只描述该work的exec路径，`none`表示容器命令无网络，`bridge`表示可路由网络且不是安全搜索服务；review seat强制none。`research.read`只表示对配置allowlist中一个已知public HTTPS URL的受限读取，绝不称作搜索或网页发现。需要发现资料时，Agent可根据实际报告选择有网络的受控exec工具、询问人/同伴提供URL、读取已有文件，或准确报告缺少发现能力。不能用模型常识猜测一个未安装的搜索adapter。

attachment input与artifact output仍由窄port提供，并增加无副作用preflight。附件port按actor报告是否配置了输入客户端及其`external-message`适用范围；成果port按actor+target报告该authority/provider组合是否受支持。核心DTO只表达`configured | unavailable`及适用范围，不宣称网络健康，也不出现Slack类型、token或客户端。`artifact.publish/revise`必须在读取和冻结文件前完成actor+target preflight；内部target或未绑定Agent立即失败，不能先产生文件快照或draft再等dispatch失败。最终调用仍逐对象检查消息可见性、文件归属、target ACL、grant和异步后的run/ACL，dispatch也继续复核；preflight和能力报告均不授予对象权限。未绑定外部adapter的Agent可以继续内部交流和文件工作，并明确看到输入/输出adapter unavailable。review seat只看到自己的clean workspace、强制离线execution和被隔离的外部输入输出；不得因底层daemon装有Slack而报告可用。

E5b用正式ToolRouter与生产服务组合验证一条合成闭环：可见消息中的文件metadata → `attachments.save`认证下载 → grant内文件读取/转换/写入`artifacts/` → `artifact.publish`冻结快照 → freshness held/revise/continue → adapter确认。测试必须证明下载/认证/ACL阶段失败不开始文件写入、异步期间撤权失败、修改源文件不改变冻结成果、未知发送不盲重试、二进制正文不进入模型draft，并覆盖没有附件adapter、没有publication adapter、allowlist拒绝、内容截断和run停止。Broker文件写已经开始后若执行或receipt为unknown，不能保证目标文件未变化；保留durable action receipt，Agent必须核实后再决定。研究只验证协议/边界，不把外部搜索质量列入验收。

新增source-backed能力矩阵，把核心体验分别关联到：真实`ToolSpec` operation、导出的`mate.environment.v1` Zod schema字段、prompt中的行为约定、权威持久状态/receipt或明确的无receipt语义、正式ToolRouter成功与失败场景。`research.read`如实记录为pure read：没有durable action receipt，结果只进入当前tool journal；不能为矩阵整齐另造状态。矩阵是防漂移清单，不另造一套运行时注册表；自动检查公开operation集合、环境schema版本、由`buildBaseline`实际生成的约定及对应语义场景，避免只匹配一组可与错误实现同步漂移的关键词。具体输入schema仍由`tools.describe`权威生成。系统prompt说明何时查询环境、如何选择grant、URL读取与发现的区别、附件metadata与已读内容的区别、成果冻结/held/unknown语义和缺失能力的替代路径。prompt或tool契约变化继续改变session baseline并走显式配置迁移。

E5设计红队重点反驳：环境报告是否成为第二个授权源或泄露宿主；配置与持久grant漂移时是否说谎；work切换或过期后旧报告能否被当capability token；review seat是否旁路隔离；“网络可用”是否被误写成“搜索可用”；静态工具存在是否掩盖adapter缺失；附件到成果测试是否绕过ToolRouter；artifact adapter失败是否在冻结/发送之间制造不可解释状态；能力矩阵是否只重复实现而不能阻止契约漂移。上述均为现有产品方向下的工程决策，无需用户另行选择。
