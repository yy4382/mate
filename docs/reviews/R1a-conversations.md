# R1a 交流空间审核

范围：Target可选thread，顶层发送/对账，身份目录与主动DM，conversation_events，旧库v8备份迁移。基线3e88d42；后续预算/注意力不在本gate。

独立红队：`/root/review_r1a`（fresh context，只读实际代码与合成故障验证）。初审FAIL：

- P1：异步目录覆盖请求期间撤权。修复：Messages维护身份membership generation，分页期间变动则丢弃完整结果，重试发现。
- P2验收阻塞：删除回复误归自己ts。修复：解析previous_message或复用已有thread；测试删除先于/晚于原消息。
- P2验收阻塞：明确失败永久阻断DM。修复：429和明确拒绝记failed，新action可重试；不确定回执可由acting身份目录查询确认。
- P2接线阻塞：mpim scopes缺失。修复：安装文档补齐mpim:read/history。

检查：pnpm run check，77 passed / 4真实隔离测试默认skipped；本模块未调用真实Slack/provider。覆盖顶层无thread_ts、旧thread target、重复/晚到/编辑/删除版本、目录分页/撤权竞态、DM去重/429/unknown恢复、v7备份权限与重开。

第二轮补修：无previous_message删除先到，迟到原回复仅补齐位置并追加正确root事件；补齐官方明确权限/身份拒绝。第三轮独立复审PASS，11个conversation测试及额外重复投递检查通过，git diff --check通过。无遗留阻塞。
