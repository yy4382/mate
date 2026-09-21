# E2b2b — 持久写入、引用索引与查询接入

状态：PASS。独立reviewer `/root/review_e2b2b_storage`，fresh context只读，未参与实现。

范围：ConversationWrites、Slack storage composition/LegacyConversationCodec写入adapter，Messages/Collaboration/Reminders/MessageTasks/Output/Freshness/Attention/ReviewSeats、相关runtime/daemon接线和测试。前置各E系列模块已有PASS，不把整份未提交diff计为本模块。

同一事务提交权威记录和索引；mutable从已写入记录解释target，delivery去重索引原始payload；消息建立根引用。显式target actions/outbox/deliveries统一writer，列表/资格过滤/unknown阻挡使用canonical索引。旧wire/hash/receipt保留，原unknown不重放。旧库显式offline migrate，新库首次设置标记。临时writer仅支持可表达的旧external目标，拒绝internal/projection或映射后无法由旧契约表达的ID。

检查：完整pnpm test（Node24）202通过、7跳过；独立6文件48/48通过；git diff --check通过。新增故障覆盖重开后的旧unknown同scope阻挡、缺索引阻止发送、事务回滚无孤儿索引、delivery去重目标、提醒改期改目标撤权、内部投影误用拒绝。

P1阻塞及修复：Attention.publications先INNER JOIN会漏掉缺失/漂移索引的sent artifact，再错误签发完整view。改为筛选前核验publication targets；缺失/冲突拒绝生成view。正式测试验证缺失、错索引及修复后分页返回。初次测试错把publication断言写在消息首页，修正按nextCursor翻页，未为测试改变生产分页行为。

工程结论：依赖方向、显式composition、writer内聚、事务和wire保存通过。短期债务：未终结outbox和sent artifacts在资格/呈现前只读校验，存在扫描开销与全局失败关闭影响；不自动修复索引。下一canonical存储gate消除该临时校验成本和反向legacy SQL转换。领域公开Target/MessageDTO和非Slack完整链路尚未切换，不宣称E2/实验版完成。
