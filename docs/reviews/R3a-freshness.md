# R3a 消息草稿与发送门控

基线e1a01e0。独立红队`/root/review_r3a`，最终PASS。104普通测试通过，4真实隔离默认skipped；红队独立当前与故障复现18/18通过。无真实Slack/provider调用。

范围：普通消息/委派发言的held草稿、不可变修订outbox、view依据、retry/revise/discard/一次知情continue、串行dispatch前再检查、429/unknown、held恢复与旧pending收容。60秒continue不赋予seen，也不能越过ACL、Agent/work stop或unknown。工具上传adapter在R5接同一提交语义，任务CAS在R4，盲审在R3b；不宣称全外部工具已完成门控。

红队发现与修复：

- P1 Agent暂停仍发送pending：ready/sendNow均检查paused。
- P1委派修稿误将任务判failed：同事务更新子任务outbox/target/version，并检查接收方新目标可见性。
- P1已持久但未normalize的ingress被遗漏：相关channel事件或owner command未处理时阻止派发，待可信replay后重新gate，覆盖ACK前窗口。

四选择及baseline_unknown、queued后变化、两个本地并发消息、429重检、unknown阻断、过期continue、stop/撤权、委派修稿与本地ingress均有合成回归。无遗留阻塞。Slack外部参与者的检查后竞态仍不能原子消除。
