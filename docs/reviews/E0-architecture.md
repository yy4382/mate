# E0 架构设计独立讨论

2026-09-21。Reviewer：`/root/review_e0_architecture`，fresh context，只读实际代码及设计文档；未参与编写。范围：ARCHITECTURE、EXPERIMENT_GAPS、IMPLEMENTATION_PLAN、AGENTS审核要求。只文档，无实现测试声称。

初审BLOCKED：
- P1：内外部提交缺持久authority/binding及echo状态契约。修订固定authority、旧Slack external、内部提交/投影失败独立、echo一次归并、回复根映射暂存与成员授权。
- P1：旧请求JSON迁移会破坏发到Slack的request_hash。修订不可变wire request/hash/receipt与版本化解析，canonical引用映射，同ID等价与变参拒绝，unknown不重放。
- P2：缺结构化mentions。修订可信adapter解析principal refs，核心不解析Slack正文。
- P2：runtime→daemon DTO反向依赖未纳入gate。修订E1检查范围，DTO/port应用层所有，E2退出legacy。

实现方与红队明确讨论上述方案并完成复审；reviewer确认两项P1及P2设计层解决，E0 PASS。复审附加E2验收：所有外部locator唯一会话路由；仅持久开始派发且具备可信证据的outbox可对账，held/prepared不能由伪造metadata确认。已写入架构硬约束。

结论：设计gate通过，允许E1实施。并不代表E1–E6代码已满足架构。软件工程质量/依赖方向/职责/迁移/复杂度作为后续每个独立gate的验收条件。
