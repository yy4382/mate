# 持久状态边界

Store 只供可信 daemon 使用，SQLite 连接和任意 SQL 不传给 worker。启动 recover 前必须持有单实例锁且旧 worker 已终止。generation 是提交隔离，不是 OS 进程停止机制。

- `register` 保持 Agent → session；配置版本改变需显式迁移，不能静默替换可信 system/tool transcript。
- `beginRun` 在 immediate 事务中挑选一个 durable delivery，唯一索引兜住同 Agent 单 active run。不同 Agent 独立。priority 带按分钟累积的 aging。
- `input` 同事务追加稳定 delivery key 与 injected 状态；恢复相同输入幂等，改写相同 key 被拒绝。输入内容（包括 timestamp）应从持久 delivery 构造，不得每次恢复重新生成。
- `appendMessage` 使用 run 内稳定事件 key；`finish` 只在已注入且 runtime 已确认无故障后调用。失败保留输入并暂停 Agent，等待显式恢复，避免模型/存储失败导致无限热重试。
- `pause` 使旧 run 失效并保留任务输入；runtime 还必须中止实际 worker/backend。
- action 执行前先 prepared→executing；没有收据的 executing 在暂停/启动恢复后成为 unknown。unknown 不提供自动重执行转换。外部对账由后续服务实施。
- 未跨执行边界的 prepared 可以在旧 run 已失效后，以同 Agent/同哈希 adopt 到新 run。failed finish 同事务把 executing 标 unknown；成功 finish 拒绝仍有 executing 的 run。
- outbox 只有 pending 可以 sending；unknown 只能通过对账成为 sent 或 failed，不能再次 sending。429 等确定未执行的请求可从 sending 返回 pending。
- snapshot 是 journal 投影，必须在 idle 写入；完整 journal 不删除。hash 损坏回退 journal。备份使用 SQLite backup API。

实现使用显式 SQL 表达短事务与状态 CAS；保留 drizzle 依赖供后续类型化查询。相对设计的此选择减少关键事务在 ORM 隐式行为中的歧义。
