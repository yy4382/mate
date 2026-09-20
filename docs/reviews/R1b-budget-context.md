# R1b 持续预算与事项解耦

基线3a77007。独立红队`/root/review_r1b`，最终PASS，修复后独立相关测试49/49通过。

范围：v9预算账户/预留记录与run_context；Agent持续额度；owner agent-budget；跨事项读取/认领/切换；选定事项stop与continuation；跨事项unknown副作用保护；同伴自主唤醒。

检查：pnpm run check，84 passed / 4真实隔离测试默认skipped。合成测试覆盖新消息不抹债务、暂停一个事项不暂停Agent、切换不改账户、停止命中当前事项、跨work未知写入阻断、历史usage保守迁移/幂等结算。未调用真实Slack/provider。

迁移说明：旧work usage没有逐run实际分摊信息，保守计入每个参与Agent，audit标明高估可能；未知预留保持，可接收后来结算。账户由配置首次建立，重启/新消息不重新播种。整个模型run记起始work与Agent账户，动作使用current work。完整session/配置迁移是R7独立gate。

红队发现及修复：P1恢复丢失选定事项，新增delivery_context供重启筛选与预留；P2重复select hash变化，去掉动作身份中的可变当前事项；P2跨入耗尽事项，动作检查上限但保留本run已有预留使用权。无遗留阻塞。
