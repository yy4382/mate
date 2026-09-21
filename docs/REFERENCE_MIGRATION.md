> E0 reviewer已同意稳定旧ID+binding优化：无需全量换UUID，但messages.key才是全局MessageId；ts是scoped local ref。以下“映射”不要求改写原wire，应用统一通过兼容reader与canonical索引解释。参见ARCHITECTURE末尾讨论。

# E2 引用迁移清单（分阶段实现）

当前schema v16；E2b1基础已通过，应用切换未完成。迁移不得重写已发wire hash或未知副作用；旧Slack会话保持external。实现可拆E2a身份配置、E2b消息引用与adapter接线，各自独立gate，不提前声称全E2完成。

| 状态 | 现有引用 | 策略/核验 |
|---|---|---|
| agents/sessions/checkpoints/resets | Agent ID/session/work ID | 身份原样，分离profile与platform binding；current session不隐式替换 |
| channel_access/watches | channel/thread字符串 | 映射内部conversation/message根，保留撤权和follow |
| messages/message_revisions | key=[team,channel,ts]、ts/thread/revision/body | 唯一外部locator映射，保留所有revision；排序转本地sequence/occurredAt，删除晚到不复活 |
| message_visibility/observations | key/revision+actor | 原ACL观察者保留，不以单bot观察授全队可见 |
| conversation_events | channel/thread/key/revision/audience | seq原样，换引用不新增假消息 |
| attention_views/presented/seen/state | target/key/pages JSON | 旧view失效；seen/resolve/defer/mute保留已处理语义，分页正文不误标完整 |
| review_seats | target JSON | 席位和隔离保持，不借新工具绕过 |
| works/message_work/delivery_work/run_context | origin/target/key | work与预算身份不变，映射引用；不重置债务 |
| deliveries | payload target/messageKey/source | 版本化读取；pending/injected/handled不重置；历史已呈现journal不修改 |
| actions | request/request_hash/receipt及run | 原始证据不可变；版本化reader，canonical映射；同ID重试/变参拒绝，unknown仍unknown |
| outbox/drafts | request/request_hash/receipt、target/fileId、revision/hold | 原始wire不可变；current canonical refs独立映射；pending按旧wire发送，unknown按旧metadata对账 |
| tasks/task_events/task_intents | message_key/target/args/receipt | canonical唯一性保留，版本/owner不变；历史event只读解析，held未提前claim |
| schedules/reminder_events/firings | target/anchor/payload/output | 作者、due/version/active和去重保留；已取消不复活 |
| entries/snapshots | 工具参数/正文/target/旧ID | 历史证据原样，旧引用走兼容解析；baseline显式升级；不继续使用旧viewToken |
| ingress/slack_cursors/admin_replies | Slack原始payload和定位 | adapter专有wire数据，不当core IDs；旧未归一输入仍可replay |
| runtime_meta configuration/policy | 旧完整config | 显式旧配置核验，分離core/Slack binding，预算不重置 |
| grants/budget_runs/ledger | Agent/work/root/action | 不改授权与债务；旧unknown仍阻挡同一实际资源 |

迁移测试必须覆盖：备份/事务失败回滚/重开、两个App看见同一消息、晚到删除、旧unknown发送与旧metadata、附件unknown sharing、同action ID旧/新引用等价及真正变参拒绝、hold/seen失效、提醒去重、配置对照。真实Slack另验，不需要其凭证才能运行这些fixtures。

内部会话验收：非Slack ID、无bot配置成员、内部DM提交只唤醒一次、projection失败不影响内部结果、外部echo先到、回复投影根尚未映射暂存、撤权与private DM不广播、外部locator路由唯一。伪造metadata不得确认prepared/held意图。

## E2b1实际范围（红队PASS）

v16只新增identity/binding/canonical target索引表；核心DTO在domain/conversations，引用目录在conversations/references，旧Slack解析在slack/reference-migration。离线配置迁移事务调用填充；保持原messages/requests/receipts/journal不变，旧view epoch首次失效。未知thread metadata保留null root，不猜root；已证明是thread根但无正文可建立root identity。

E2b1测试覆盖legacy同ts跨频道、没有root正文、unknown消息/附件wire原样、重复迁移、冲突回滚、v15备份/重开与UUID本地身份。尚未把生产消息服务/工具/发送查询切到canonical DTO；下面E2b2必须完成，不能把本阶段视为新旧发送已经统一阻挡。

## E2b2切换审计清单

- 为只读旧target/消息ref提供单一版本化reader；不是每个服务自己解析Slack。
- Messages/Attention读写使用domain Message（全局id/conversation/root/author/mentions/显式排序与版本），存储旧列名可以保留。
- FreshnessGate、Output与task intent均通过同一canonical target读取/索引；旧unknown必须阻挡同scope的新请求。
- 输出适配器接收内部target，通过binding回到外部locator；对账仍比较原wire hash和可信证据。错误分类移到adapter。
- tasks/reminders/work/review/attention可变target引用切换；不可变wire/历史保持原样并经reader解释；旧view已失效。
- Runtime tools不再暴露Slack user/bot ID或ts格式规则；历史同action ID旧/新参数等价只经过集中兼容判断，真实变参拒绝。
- Ingress/目录/附件/历史查询用统一mapper，不以内部ID字符串前缀推断平台。
- 逐项完成迁移fixtures和非Slack场景，进入独立gate后再开始E2c。

## E2b2a 解释边界与后续接入约束

独立架构讨论允许先验证只读codec/records，无生产writer或SQL切换。发送者author与可信origin分开；非Agent principal以provider/workspace命名，未知作者没有可用于身份判断的ID。数字order/revision使用统一整数验证和比较。records校验body身份、target映射与索引，但不授予ACL；targetedEffect仅支持显式target，不代替间接task/work action授权。

下一gate的写入/读取核对：

- works：Collaboration.createWork，work/list/select与runtime works.list。
- tasks：Collaboration.createTask、Coordination claim/create、FreshnessGate.revise连带target更新；task/list/claim/delegate/wait。
- schedules：Reminders.create/edit；read/list及tick批次LIMIT前的ACL资格过滤。
- task_intents/review_seats：创建与版本操作；runtime intents和席位输入限制。
- outbox：Output.queue/queueArtifact、FreshnessGate.revise、提醒/任务固定系统回执、旧Store直接调用；ready/sendNow/dispatch及unknown同scope阻挡须一起切。
- actions/deliveries/attention/watch：所有显式target载荷和索引更新同事务；不把未索引unknown当成不存在。

不采用每次查询重新扫描全库“补索引”；缺失索引明确失败，生产写入应负责原子维护。数据载荷仍是一份事实源，canonical_targets只是校验/查询索引。将core MessageDTO接入生产前保留legacy facade，并在E2c删除临时writer。

## E2b2b 当前接入范围（独立审核PASS）

ConversationWrites由composition显式注入，不使用Store全局hook。应用用例拥有事务；mutable索引读取刚写入的权威target，delivery去重索引读取原存储payload而非新调用参数。消息保存同事务建立引用。生产显式target action/outbox/delivery、works/tasks/schedules/intents/review seats/attention/thread watches都进入该边界。

目标过滤（任务/事项/提醒/草稿/成果及unknown范围）改用canonical_targets；读取权威对象时校验索引。Output在派发资格检查前核对尚未终结的outbox，缺失或冲突明确抛错，不能通过JOIN漏掉unknown；该检查只读，不自行修复。保留索引SQL的LIMIT前资格筛选，不能使热/阻塞目标饿死其他会话。

临时writer只能表示历史external会话（内部ID沿用旧channel）；拒绝internal/projection或不等于旧channel的映射。完整opaque引用与canonical存储是下一gate，当前限制不得当成最终架构。旧库需显式offline migrate；新库只在首次初始化设置引用迁移标记。不会每次启动或查询扫描全库补索引。
