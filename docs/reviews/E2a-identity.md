# E2a 内部成员定义与查询

2026-09-21，PASS。独立reviewer `/root/review_e2a_identity`，fresh context，只读实现及测试。

范围：domain AgentDefinition/TeamSettings、ConfiguredAgents、runtime worker/session/baseline与调度成员查询、预算窄类型、兼容旧config schema。配置provider只读；非动态CRUD，Slack部署格式与消息引用由后续E2b/E2c处理。

初审P1：schema extend改变model字段序列化顺序，启动/迁移按JSON字符串比较，导致旧R8配置无法迁移。已改为同一sameConfiguration结构比较（schema/default+对象键排序）；绝不改变wire encode/hash。新增手工旧字段顺序、旧baseline和unknown outbox回归，同配置迁移保留不可变证据。此前复审曾因额度失败中断，未绕过gate；用户continue后恢复独立审核。

实现方全套构建183passed/7skip；独立reviewer复跑directory/supervisor/migration/architecture 37/37通过，确认P1解决、无剩余本阶段正确性/恢复/架构阻塞。E2a PASS，不代表E2整体完成。
