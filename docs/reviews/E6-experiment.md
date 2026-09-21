# E6 实验验收 — PASS

日期：2026-09-21。基线：`ebf2ed3`。独立只读红队：`/root/review_e6_experiment`，fresh context，未参与实现。范围：预配置双成员Slack/local示例、正式Daemon本地多选择场景、静态检查报告、实验运行及真实Slack/provider接线清单、README与验收证据。

实现结果：`mate.example.json`与`mate.local.example.json`使用同一平台无关Agent定义，Slack installation只存在于adapter binding。本地示例通过正式Daemon、Supervisor、ToolRouter、attention、freshness gate、持久Store和LocalConsole运行，没有另造业务模型。测试证明同一owner message分别为两个Agent建立delivery；两者从各自active run核对该delivery，并通过正式`attention.read`读到相同messageId与正文，随后一个显式发言、一个沉默。真实接线手册明确合成协议与真实账号验收的边界，不发送外部测试消息或冒充完成。

红队初审发现并修复两项P1和一项P2：

- 安装清单缺少`conversations.join/leave`所需scope。现由`requiredSlackBotScopes`单一代码常量列出完整功能scope，静态检查报告机器可读返回；README、runbook和回归测试逐项核对。补入`channels:join`、`channels:manage`和`groups:write`等适用权限。
- 原测试只按Agent ID决定发言/沉默，可能由后续peer消息掩盖某个Agent没有收到owner输入。现显式核对两个初始delivery绑定同一消息，并只把由该消息触发且成功读取正文的run计入实验结果。
- `configuration_and_local_prerequisites`夸大静态检查范围。现更名为`configuration_model_and_secret_references`，并明确不检查dataDir、容器、token授权、外部身份或网络。

红队复审无P0–P2。目标测试3/3、类型检查、diff检查通过；完整普通集333项通过，7项需要显式真实隔离环境而skip。E6 PASS；真实Slack/provider仍按手册列为未验，后续进入V1 Linux运行与沙盒。
