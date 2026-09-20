# R2 注意力与呈现

基线7176a6b。独立红队`/root/review_r2`，最终PASS，无遗留发现。

范围：持久注意力状态；不可变分页视图和完整toolResult journal ACK；channel/thread watch；mute/defer到期单次唤醒；Pi模型调用断点nonce RPC通知；压缩/投影epoch。

pnpm run check：95 passed / 4真实隔离默认skipped。模拟验证多页ACK/修改结果不ACK、seen与resolve独立、编辑/重复与epoch、撤权、defer到期单次唤醒、真实Pi loop在工具完成后下一模型输入看到notice且可以继续原工作。未调用真实Slack/provider。

覆盖范围仅本地已观察且该身份可见的消息；分页快照超过10000条或单条超限会显式不完整，不能用于完整view。run投影交接保守失效view，不清seen或处理状态。mute不撤销已开始run。R3实现held draft后可知情继续而非强制读完所有消息。

红队修复：P1新可见消息不失效视图，增加身份可见性event；P1读取回放越过ACL，回放前验证并重投影搜索/list；P2通知只进临时输入，现同步保留Pi loop与state；P2频道mute未拦延期唤醒，tick复用频道状态。P3旧快照ACK回退seen，按BigInt版本单调更新。独立4项复现18/18通过，最后注意力8/8通过。
