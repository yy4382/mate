# E2b1 引用目录与迁移基础

2026-09-21，PASS。独立reviewer `/root/review_e2b1_references`，fresh context、只读实现及临时复现。

范围：domain引用、References identity/binding/root目录、v16 schema备份/升级、旧Slack迁移adapter、离线配置迁移接入、派生target索引。旧wire/action/hash/receipt/journal保持原样；应用语义切换留E2b2，内部通信留E2c。

初审P1：先到无thread元数据tombstone被永久声明root，晚到原reply补thread后再次迁移冲突。修复：deleted且ts=thread只reserve null root，真实位置证据再enrich；真正跨会话/矛盾根仍拒绝。新增磁盘关闭/重开、晚到补根/重复迁移、不复活正文回归。

实现方全套构建190 passed/7 skip；独立复审reference/config migration 14/14通过，额外验证两种插入顺序中其他reply证明删除消息是根、重复迁移不降级、冲突改根拒绝。无剩余本基础阶段功能/恢复/架构阻塞。E2b1 PASS，不代表核心已平台无关。
