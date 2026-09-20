# Mate 实施计划

2026-09-20；依据 HANDOFF、技术设计、v1 scope 与本地 Raft 只读证据。工作目录与已保存项目 mate 路径均为 `/Users/chris/Developer/demo/mate`。

## 交付规则

模块按下表顺序实施。每个模块先通过本地检查，再由未参与实现的独立红队读取真实代码/测试；修复所有验收阻塞并复审后才启动下一模块。审核记录写入 `docs/reviews/`。外部凭证缺失不阻塞纯本地实现，但模拟验证不代表真实服务验收。

| 模块 | 目标与接口 | 依赖 | 验收与有意义验证 | 状态 |
|---|---|---|---|---|
| A 基础与 SDK 契约 | TS ESM、锁定依赖、配置校验；验证 Agent/message_end/tool/idle、TypeSafe 请求接口、SQLite | 无 | 实际安装类型检查；假模型驱动真实 Pi 工具循环、异步订阅屏障与失败行为；SQLite 事务回滚；SDK 离线传输契约 | PASS，review_a，11 tests |
| B 持久状态核心 | Store：Agent/session/journal、inbox、run generation、intent/outbox、恢复与备份 | A | 关闭重开数据库、去重、单 Agent 单 run、旧 generation 拒绝、未知副作用不重放、输入/journal 原子提交 | PASS，review_b，19 tests |
| C Slack 消息服务 | 持久 receiver、normalize、ACL、attention、read/search/send、显式 target、outbox 对账 | B | commit-before-ack、双 app/echo 去重、乱序编辑删除、撤权、429/unknown 故障注入；真实 Slack 另验 | 进行中 |
| D 协作与调度 | tasks/dependencies、work budgets、subscriptions、持久 schedules；owner 控制 stop/resume | C | CAS 认领、等待释放、继承预算、取消和 catch-up 幂等、依赖完成原子唤醒 | 待实施 |
| E 权限与执行 | trusted broker、grants/intents/approvals、Jev 官方 SDK、隔离 backend、文件与 memory 原子写 | D | 跨 Agent/路径/符号链接/过期审批/变参攻击；Jev 失败关闭；真实本地沙箱阻断与停止；中文 Jev 评测待凭证 | 待实施 |
| F Pi worker 与上下文 | restore/run/checkpoint/compact/abort、IPC、每 Agent 独立进程、memory 恢复包、合法工具投影 | E | 两频道同 session、两 Agent 独立、message_end 持久屏障、kill/restart、压缩闭合边界、审批释放/停止 | 待实施 |
| G daemon 与日用验收 | main、Slack 管理入口、研究/成果工具、运维日志、备份恢复、配置示例与启动文档 | F | 合成双 Agent 全链路、故障矩阵、配置 fail-fast；真实 Slack/model/Jev 及任务质量比较独立列为未验 | 待实施 |

## 与交接设计的关系

- 将 M0–M3 按基础依赖分解为 A–G；风险契约分布在 A（SDK）、C（ack）、E（沙箱/Jev）、F（worker/压缩）。不把尚未实现的 M0 全部标为完成。
- 保留应用拥有的 SQLite 事务边界、Pi Core + pi-ai、官方 TypeSafe SDK；不引入 coding-agent。
- 主机当前 Node 为 26.8.2，设计要求 Node 24；优先获取本项目隔离的 Node 24 工具链，不更改用户系统默认 Node。
- Jev 在完成真实校准前只作为信号，不能根据未校准分数自动扩大执行权限。
- 本地私有 reference 不进入 Git，测试全部使用合成内容。不部署、推送或发送外部消息。

## 未完成的真实验收

Slack 安装身份/成员与 bot echo、真实模型调用、Jev 中文样本错误率与延迟、受支持 OS 的沙箱行为、真实任务协作质量。凭证和特定外部动作授权到位后执行，不以 mock 代替。
