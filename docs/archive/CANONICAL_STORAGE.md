# E2b2c — 规范契约与可变存储切换清单

状态：生产入口已完成切换，本地220项通过、7项真实环境测试跳过；独立红队复审PASS，未通过gate。依赖E2b2b PASS。与review_e0_architecture讨论后合并原领域契约及canonical可变存储两个步骤，避免大量短期反向转换。此模块仍必须完整检查及独立红队后才进入内部通信模块。

## 数据与版本

同时推进schema到v17，让旧程序拒绝误读；使用明确持久格式标记区分应用数据版本，不通过C/U前缀或任意JSON字段猜版本。现有SQLite列名可暂留，但含义统一：messages.key是全局MessageId，channel是ConversationId，thread是根MessageId（未知为NULL），ts为规范十进制order，revision为规范十进制版本。消息正文仍是一份事实源；旧body由legacy reader解释，新body带明确format。conversation_events.seq不改变。

可变target（works/tasks/schedules/task_intents/review_seats/attention_state）、schedule anchor、task_intent message参数、deliveries中的target/revision/ref转换为内部引用。task_intent已应用receipt、task/reminder事件和journal/snapshot是历史记录，不原地改写。旧attention_view保留但统一失效，不能改旧页后继续承认旧view。

message_revisions/observations/seen中的消息版本同步转整数；artifact等非消息revision保留原语义。thread_watches、事件定位同步转根引用。旧message.key、任务归属、delivery去重key/status、预算与grants保持。所有转换同事务，任何冲突回滚；离线迁移先备份。

## 不可变副作用

outbox/action request、request_hash、receipt原字节不改。reader依据明确payload版本解释目标，新请求用规范版本。发送port携带持久effect身份/hash，Slack adapter不得从转换后的参数重算旧hash。unknown的新旧请求按同一canonical scope阻挡，对账仍验证真实作者/定位/content/hash，prepared/held不被metadata确认。

旧工具参数在一个兼容入口解析。相同action ID重试按旧记录版本归一到同一语义再比较，真正换目标/正文/授权拒绝；不通过覆写原request来适配新参数。

## 生产切换与删除债务

同时改Messages/Attention/Freshness/任务/提醒/runtime工具、writer/recovery reader，以及现有Slack external输入/输出。核心不再解析Slack mention/user/bot/ts；adapter提供author、mentions、origin、order/revision。暂未实现internal send时明确unsupported，不伪装外部发送。

删除E2b2b的legacy writer和canonical→legacy thread查询转换，以及查询前全量扫描索引的临时验证。可变规范target成为直接权威查询字段；不可变effect的目标通过受控版本reader/index保持一致，不再有两套可变target。

旧reference迁移在规范格式标记生效后不能再次扫描legacyTarget.parse全表；第二次配置迁移/重开必须走对应格式校验。新库初始化与旧库迁移必须落到同一个当前格式，不保留默认旧模式。

## gate最低验证

- 旧库升级两次重开/再次配置迁移；备份、失败事务回滚。
- 新规范线程跨消息、任务、提醒、attention、草稿和附件闭环；非Slack格式内部ID可用于external绑定。
- 旧unknown与新请求相互阻挡；旧metadata及附件sharing对账。
- 原wire/hash/receipt/journal字节不变，旧delivery不重复唤醒，预算不重置。
- 旧参数等价重试、同ID真实变参拒绝，授权与可见性不混同。
- 工具schema、prompt和返回结果明确内部引用；现有Slack协议适配通过合成协议测试，真实接入单列。


## 格式讨论补充（review_e0_architecture）

全局format与可变转换/索引/epoch/schema版本在同一事务提交；缺失format仅允许已知v16，未知值/不匹配版本失败。无载荷format仅表示已知v1，未知或畸形format不得退回v1；不补写旧request标记。消息根改为NULL时同时调整NOT NULL列约束。

重复事件必须由规范化后的message observations阻止创建第二delivery，不能只说“dedupe key不变”；验收pending/injected/handled、echo、提醒三类重放。legacy reader只从body+binding解码，不将已变换的ts/thread列再当外部locator。历史task-intent receipt/事件及journal中的引用在展示/调用入口走对应版本兼容，不能直接解析后绕过当前授权。

## 实施后的查询契约（2026-09-21，review_e2b2c_canonical讨论）

v17删除过渡canonical_targets表。可变target直接从所属行canonical JSON读取，任务/work/reminder/intent按表达式索引查询，不双写另一份可变定位。outbox因保留原wire而增加同一行的canonical target；离线迁移在事务内由版本reader生成，新写入必须携带routing target。数据库触发器要求新outbox具有已知conversation/root，且routing target一经写入不可更改；更改草稿产生新outbox身份。查询unknown/列表/附件使用这一行target，reader再核对原请求解释是否一致。不以可缺失的镜像索引行决定unknown阻挡。Store.output仍仅返回Effect公共字段，不把物理schema列混入协议。

旧wire/request_hash/receipt/journal保持；新版body/effect/task-intent回执分别有明确版本标记。旧消息回执通过兼容reader解析消息ID；原始回执不覆写。全局格式迁移同步转换delivery来源principal，避免旧external_bot标识继续流入新调度语义。重复运行canonical迁移为校验后的no-op，直接调用v16迁移在v17拒绝。

旧生产实现及旧writer仅保留于tests/fixtures/v16和tests/fixtures/legacy，用于构造历史库及历史协议测试；应用src不保留可运行的旧Messages/Output并行路径。当前完整回归统计含历史夹具测试；新canonical验收另由ingestion、canonical-flow、canonical-actions、canonical-adapter及已迁移的任务/提醒/运行时/daemon测试覆盖。

新增回归包含：旧unknown与新thread/top-level互相阻挡及不同thread推进；通过真实Slack适配类但模拟HTTP验证metadata使用持久hash；authenticated旧echo确认；历史edited.ts更新；routing必填且不可改；已读附件echo去重；系统回执不触发同伴工作。真实Slack/provider、Linux隔离及部署不在本gate冒充通过。
