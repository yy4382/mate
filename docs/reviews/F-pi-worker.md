# F — Pi worker 与上下文（PASS）

基线：`223df68`。实现范围：`src/runtime/`、`tests/runtime/`、合成进程入口 `tests/helpers/worker-fixture.ts`。C/D 的 send id 参数改为显式 string，以支持持久动作 ID；测试脚本先编译子进程入口。

- 每 Agent 持有独立真实 Node 子进程及 Pi Agent；只传当前 provider 密钥，不继承 Slack/Jev/主机环境。daemon 固定身份、session、generation/work，不接受模型提供的 actor。
- 输入在运行前提交；message_end 通过 IPC 等待 SQLite ACK；动作通过 daemon 重新验证并记录事务回执。运行错误、持久化失败、kill/timeout 保留不确定预算，不把 idle 当成功。
- 中断 tool batch 在模型投影中补充明确的 unknown 结果；原始 journal 保留。恢复不会自动重放历史调用。审批通过 actions.retry 精确复用原动作 ID。
- 预留预算先于 provider 请求，单次 request 限 maxTokens、上下文、累计用量；Pi 官方摘要函数使用同一个有界 stream，保留 system 和最后完整 user turn，快照在 run 完结事务中提交。
- tasks.wait/approval 释放当前 run，同一 Agent 可继续其他频道；连续工具循环达到 turn cap 后进入持久 continuation 队列。

本地验证：`PATH="$PWD/node_modules/.bin:$PATH" npm run check`，55 passed、3 个真实隔离测试默认 skipped。包括真实两个子进程的跨频道上下文/跨 Agent 隔离、环境白名单、持久屏障故障、预算调用前拒绝、wait 后 batch 截断、压缩闭合边界、kill 后保留输入/预算并恢复、工具幂等与工作域边界。

独立 reviewer：`/root/review_f`，fresh context，read-only；已独立运行全套55 passed / 3 skipped，最终 PASS。不代表真实 provider/Slack/Jev 集成。

## Findings 与修复

- P1：run内上下文扩张时来不及压缩。已增加首次运行前及闭合tool turn阈值检查、持久continuation；超长前缀按有界reference分段累积摘要。reviewer独立复现25k工具输出/20k window，真实Pi摘要helper接入有界合成stream后第二run成功。
- P1：完整task result使recovery越界且IPC静默超时。恢复包只含有界任务索引，memory入口8KB明确提示不完整及整理需求，保留全文hash；worker对无效请求立即失败。
- P2：inbox.list未执行fresh ACL。已统一过滤，只返回元数据；read/ack复核当前访问。ack使用v5 inbox_reads独立回执，绝不把queued delivery标handled。
- 补充崩溃窗口：动作事务已提交但toolResult未落盘即worker失败，恢复注入历史receipt，不重建任务；原始journal不变。

无未解决验收阻塞。F定义并测试memory恢复callback及hash；G负责真实文件路径、安全backend读取和隐式自有memory grant装配。未声称实际provider/Slack/Jev验收。
