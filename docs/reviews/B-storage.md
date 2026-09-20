# B 持久状态审核

- 作者 /root；独立 reviewer /root/review_b，fresh context，只读。
- 范围 src/storage/schema.ts、store.ts、tests/recovery/store.test.ts、vitest.config.ts、STORAGE_CONTRACTS。
- 初审发现：P1 prepared 在 restart 后绑定旧 run 无法续接；P2 failed run 遗留 executing action，成功 finish 也未要求结算。
- 修复：同身份/同哈希/旧 run 非 active 才 adopt prepared；失败事务中 executing→unknown；成功 finish 有 executing 则拒绝。
- 验证：数据库关闭重开、竞争连接、注入失败回滚、重复输入、generation fencing、stop/resume、unknown 禁止重放、snapshot/journal 与 backup。
- 独立复审 typecheck + 19 tests PASS；两项关闭，无剩余 blocker。B gate PASS。
- 外部对账、实际停止进程、单实例锁属于后续模块；Store 仅可信 daemon 可调用。
