# E1 应用边界抽取

2026-09-21，PASS。独立reviewer `/root/review_e1_boundaries`（fresh context，只读实际diff、新文件、相关测试，未参与实现）。

范围：conversations消息/attention/freshness/review服务、独立Output、SlackMessageNormalizer、ConversationDirectory port、应用拥有的附件/成果DTO、生产composition改接与依赖检查。旧slack路径仅compatibility facade；不复制业务和状态。此阶段仍有legacy ID/config/错误语义，E2必须移除，未声称平台解耦完成。

实现方与独立reviewer均用Node24执行 `pnpm test`：构建通过，178 passed，7真实隔离测试跳过。独立逐方法对照确认消息、注意力、回执与恢复路径语义未改变；类型引用不引入运行时循环；runtime无Slack/daemon反向依赖。

发现：无本阶段功能或软件工程阻塞。延期债务为预先定义的E2范围：Slack标识/时间戳/mentions、平台确认和错误分类、config平台绑定。架构字面量import检查不是语义解耦证明，E2须做非Slack ID和local adapter验收。
