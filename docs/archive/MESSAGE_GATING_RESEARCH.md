# 消息门控调研与 Mate 设计建议

2026-09-20。调研完成；本文记录设计依据。当前接口与行为以源码和测试为准。目标是假设模型足够聪明，为它补足并发感知与选择入口。不是Jev/命令审批，也不是训练一个裁判模型决定谁能发言。

## 1. 一手证据与边界

| 来源 | 已核对事实 | 对Mate的意义 |
|---|---|---|
| [Raft官方文章，2026-05-21](https://raft.build/resources/blog/is-having-agents-in-the-room-meant-to-be-chaotic/) | inbox让Agent主动取用信息；held draft对比构思依据与当前讨论状态，让Agent重新选择 | 最贴近本项目目标的方向；文章不是完整服务器协议，不能由此宣称审计过其实现 |
| 本地[Raft prompt](../reference/raft-prompt-sep14.md)，Sending messages / Message Notifications | 有saved draft、send-draft、显式anyway、reviewer-isolation；忙碌时有content-free notice | 展示模型实际拥有的交互选项；盲审下门控不能泄露正文/作者/模型已见游标 |
| HANDOFF所列9月14日原始session，JSONL 226、320、517、531行工具回执 | 实际发生发送held、保存草稿，以及任务更新未应用；226/517为成员变更，320/531为任务状态通知 | 证明不是仅写在prompt的愿景。事件型变化也可能触发；不复制私有消息/身份到报告或测试 |
| [OpenClaw steering queue](https://docs.openclaw.ai/concepts/queue-steering) | 区分steer/followup/collect/interrupt；普通steer不杀死已经运行的工具，在执行边界处理输入 | 运行中送达/调度与提交时freshness是不同层，可以组合 |
| [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams) | 同伴独立context、直接通信、mailbox送达与共享任务认领；另有完成/空闲hooks | 可参考通信/任务契约；所查文档不足以证明有Raft式held draft，不将两者混称 |
| 已安装Pi Core 0.86.0 [声明](../../node_modules/.pnpm/@earendil-works+pi-agent-core@0.86.0_ws@8.21.3_zod@4.6.5/node_modules/@earendil-works/pi-agent-core/dist/agent.d.ts) | 有steer、followUp和context/turn hooks；调研时Mate尚未接入；现由模型调用边界的notice RPC接入 | 不需要换成coding-agent；仍须验证IPC、持久化、hook顺序，不把内存队列当持久inbox |

Claude文档还描述auto mode的消息分类检查，那属于另一类安全策略，不是我们要引入的freshness机制。本轮没有启用第三方消息分类或命令审查。外部网页为本次查询快照；不据其版本信息推断本项目兼容性。

## 2. 需要分开的四层

1. **可达性/注意力**：谁有权看哪里；订阅、mute、批量notice决定何时提示。默认允许参与的空间中，非@讨论也能被发现；模型决定是否拉取内容。权限撤销和stop仍是硬控制。
2. **运行中送达**：普通notice在安全断点进入当前Agent，不立即终止运行；显式用户纠正可走更高优先级输入，stop走abort。不能把“已排队”说成“模型已读”。
3. **提交时新鲜度**：只在相关交流状态变化时hold拟发消息/任务变更；反馈差异并保留动作选择，不以内容质量替模型裁决。
4. **硬一致性**：task ownership CAS、ACL、授权、取消与持久动作去重。知情继续只能越过freshness hold，不能抢走已认领任务、越权发消息、恢复取消的动作或重放unknown副作用。

防抖、只响应@、固定发言轮次、LLM相关性过滤都不等于第3层。尤其不要为了“降低噪声”默认抹掉参与讨论的能力。来源/事件去重、自己的echo及同一状态重复通知可以代码抑制；对一条新的同伴消息是否有价值，应留给模型。

## 3. Mate协议设计

### 3.1 版本与真正呈现

每个对话目标维护本地`observedRevision`。新增、编辑、删除及相关任务变化是revision事件；晚到的旧Slack ts也形成新的本地revision。消息身份与版本分开，分页/截断有coverage描述，不能把最大ts当成“之前全部读过”。

读取返回daemon签发的`viewToken`，绑定Agent、session epoch、目标、已呈现消息版本/覆盖范围。worker实际接入对应完整toolResult并持久化journal后才ACK呈现；只有计数的notice、数据库已收、搜索返回少量命中都不能推进整段已呈现范围。这里的“呈现”证明输入进入可恢复上下文，不证明模型认知理解。

在调用模型前，runtime确保工具结果已接入本次输入投影；崩溃窗口保守处理为待重呈现。换session或上下文裁剪不能沿用已失去依据的token。压缩若只保留摘要，要重新取得有效viewToken必须重取必要上下文；也可按3.2的baseline_unknown hold选择明确继续，但不推进seen。不假设摘要等同于逐条看过最新原文。

`seen`与`resolved/deferred`独立：读过可以仍未处理；结束run不能把notice或未读消息标成完成。peek只返回可见目标的有限摘要，read按需读正文并返回窗口/分页，resolve或defer是模型明确动作。

### 3.2 提交返回可行动的结果

概念调用（operationId由daemon生成，实际schema用tools.describe）：`messages.send(target, body, viewToken?, operationId)`；任务变更另带`taskVersion`。初次打开新目标可先read，空房间也返回有效token；没有有效token时返回`held: baseline_unknown`和保留的draft，而非虚构已读或强制先读完正文。模型可选择取得视图，也可在明确知道未读/变化范围后选择知情继续；两者不能混为同一seen凭据。盲审首发也走opaque hold receipt，不要求取得被隔离的正文token。

```text
读取目标 → viewToken
构思 → 提交send/claim/update
           ├─ 相关视图仍有效 → 接受动作
           ├─ 视图变化 → held + durable draft/intent + 可见变化提示
           │               ├─ 读取后修改
           │               ├─ 原样重试（再次检查）
           │               ├─ 放弃或保留待以后处理
           │               └─ 明确知情继续（仅跳过新鲜度）
           └─ 权限/所有权/stop不符 → 拒绝，不能用anyway覆盖
```

`held`不是发送失败、不是已发送、不是普通待发outbox。默认不自动重试，不自动丢弃正文，不因重启转为pending发送。draft的目标/正文版本/依据/hold原因/作者/选择均持久化。Agent可list/read/revise/discard；修改目标或正文产生新revision。

显式继续绑定daemon产生的`holdId + draftRevision`及明确选择；不允许初次发送带一个永久`anyway=true`关掉所有检查。一般hold可直接提供有限的新内容，也可只提示变化、由模型拉取；无论哪种都必须如实说明呈现覆盖范围。达到上限时允许保留/沉默/有限知情继续，不强制读完整个频道，更不无限自动重试。

任务claim/update被hold时**不修改任务状态**；重试时再做taskVersion和owner的原子校验。对同一原始消息的认领必须有规范唯一键，不能靠多个独立task对象规避冲突。命令执行不自动纳入此门控。

### 3.3 门控范围与盲审

thread操作默认关注thread及影响它的根消息/任务状态；频道顶层关注频道目标；DM关注该DM目标。显式依赖可增加相关视图，不因为无关频道有人发言就阻止提交。scope规则可解释且有测试，不用另一个模型偷偷决定什么“算重要”。

盲审是显式review seat约束：普通inbox、read/search、恢复包及hold返回全部遵守同一隔离投影，不能只隐藏hold正文却从其他工具漏出。只暴露held状态和有限计数，不暴露作者/正文/时间线/模型已见token。内部保存opaque版本和draft receipt；知情继续从hold receipt恢复，不要求先读受隔离内容。seat启停须来自显式授权，Agent不能为了清除hold自行退出。隔离只能防止新的信息流入，不能让模型忘掉已经看过的结论；建立盲审seat必须检查输入上下文/memory来源，必要时使用独立reviewer身份与干净上下文，不靠隐藏后续通知宣称实现盲审。

### 3.4 Slack一致性必须说清

Slack [chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/) 的`thread_ts`是可选参数；因此旧Mate强制thread是自身缺口，R1a已移除该限制。该API公开参数没有“仅当整个频道仍是某revision才发出”的比较提交契约；`current_draft_last_updated_ts`描述草稿本身，并非房间版本。结合异步[Events API](https://docs.slack.dev/apis/events-api/)，**本报告推断Mate无法在Slack上复制拥有聊天室数据库时的全局原子freshness保证**。

Mate能保证的是本地已观察状态：

- daemon内按目标串行化gate与发送派发，处理已落盘相关ingress，并在真实发送前再次检查；发送回执更新本地视图。多个本地Agent并发发送按次序检查，后一方能看到前一方已确认的改变。
- queued到dispatch之间的变化也会hold，并产生一次持久唤醒；模型只收到queued receipt时不得声称已发送。
- 429等待后重新校验；崩溃/网络丢回执转unknown并对账，不自动重发。unknown的本地派发先对账或走明确处置，不让“anyway”复制不确定消息。
- 本地按目标顺序不等于锁住Slack：外部人类/其他app可能在检查后、HTTP提交前发消息；延迟事件也可能晚到。可作有界预发送补抓与gap记录，但不能消除这个竞态。不可声称绝无过时发言。

如业务以后要求所有参与者严格比较提交，必须另有掌握权威写入顺序的消息服务/协议，那是超出当前Slack替代界面的产品选择。本轮不引入第二个聊天前端。

### 3.5 预算、唤醒与恢复

held反馈可在当前turn内处理；若run结束，draft仍在Agent工作列表。用户配置的持续预算允许Agent后续处理，不要求找一条新human消息来创建work。预算耗尽如实显示并保留草稿/未读；不会因hold无限补预算。无变化不反复唤醒，每次相关revision变化最多一个去重信号，模型可defer。

Agent收到新事项时，可以保留旧事项上下文并切换，不将当前输入的work ID塞进所有工具的ACL。动作的成本归属与控制范围仍明确、不可伪造；停止某事项不等于停止Agent所有其他事项。

## 4. 合成验收要求（当前证据见ACCEPTANCE）

| 场景 | 必须可观察的结果 |
|---|---|
| A读到v1，B更新到v2，A发送 | A得到held；Slack无发送；草稿重启后保留 |
| A修改/原样重试/放弃/明确继续 | 四种路径都可达；原样重试遇到v3会再hold；继续不跳ACL/CAS/stop |
| A、B同时claim同一消息 | 至多一个owner；被hold的一方没有提前获得所有权 |
| 只peek计数、分页缺口、结果未ACK | 不宣称相关正文已呈现；不会用最大序号掩盖缺口 |
| 消息编辑/删除/晚到旧ts | 相关view失效；同一事件重复投递不反复失效 |
| 无关频道变化 | 不阻塞当前thread；root/显式依赖变化按定义触发 |
| 热频道连续变化 | 无自动忙等；Agent可defer/discard或显式继续；无无限预算补发 |
| 新盲审seat无token首发及hold后重启 | 首次submit产生opaque held receipt，重启可恢复并明确继续；不要求读取隔离正文、不伪造seen |
| 盲审各输入路径 | read/search/inbox/recovery/hold都不泄漏受隔离信息；可保留或按授权交付独立结论 |
| send queued后新消息、429、断线 | dispatch前再检查；明确queued/held/sent/unknown状态；unknown不重复发送 |
| gate之后出现尚未到达daemon的Slack消息 | 测试记录已知竞态，不能伪造端到端原子保证 |
| run/session重建、压缩、预算暂停 | 未读/草稿/ownership不丢；旧view按上下文依据失效；恢复后不自动发送 |

这些是协议测试，不依赖模型在研究中表现好不好。R0只形成设计与研究证据，R1+将分别实现、检查并经独立红队gate。
