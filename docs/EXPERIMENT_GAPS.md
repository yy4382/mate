# 实验版差异与能力分期

2026-09-21。基线是已实现R1–R8，不等同完整Raft复刻。来源：本地只读raft-prompt-sep14及channel/session/memory证据；官方 https://docs.raft.build/features/agents/workspace/ 、 https://docs.raft.build/features/agents/reminders/ 、 https://docs.raft.build/features/messaging/channels/ 、 https://docs.raft.build/features/collaboration/tasks/ 、 https://docs.raft.build/features/messaging/activity/ 、 https://docs.raft.build/search-your-raft/ 。不复制私有memory或身份进测试。

| 大类/小点 | 当前事实 | 实验版现在 | 日常版/未来 |
|---|---|---|---|
| 持续身份/工作区 | 已有每Agent跨频道session、私有workspace、重置恢复 | 保留并回归，不规定记忆分类 | 角色管理界面 |
| prompt/说明 | 现有概括性baseline和schema发现 | 逐模块补实际行为/失败/替代路径手册 | 无需等待UI |
| 动态成员 | 静态config，离线迁移可新增 | 内部身份服务边界，预配置成员实验 | 明确要求后提案/修改确认/创建；不是定时自主增员 |
| 自主参与 | 列已加入空间、watch/mute；缺join/leave | 能力明确的发现与参与接口 | 高级频道管理 |
| 注意力 | mute/defer在direct判断后统一阻断 | 区分普通静音、直接mention/DM、暂缓 | 精细偏好UI |
| 历史 | 本地缓存基础搜索，无around/filter | 分页/上下文/覆盖范围、当前ACL历史 | 完整搜索UI |
| 协作/任务 | 已有原子claim/交接/held intent；prompt prefer过弱 | 明确行动请求认领，普通讨论自由；结果/复核可达 | 图形看板 |
| 未来工作 | 已有作者reminder、cron/log | 安静工作、回执和真正结果区分、恢复回归 | 日常activity频道 |
| 工具/成果 | file/exec/附件/URL read已有 | 环境可发现；研究路径不能误称搜索；成果闭环 | 按需外部服务 |
| 人类掌握 | owner controls有，信息分散 | 结构化状态/活动查询与基本本地入口 | 网页、创建表单、改进Agent |
| 平台解耦 | target/Agent/调度/通信依赖Slack | 内部模型、应用服务、local/Slack adapter，分阶段真实迁移 | CLI/其他平台完整产品 |
| 部署 | 本地隔离已验，真实Slack/provider未验 | 本地实验和真实接入步骤，清楚标识模拟 | VPS HTTPS、直接SSH，无缓存平台 |

核心：身份/注意力/历史/协作/提醒/工作能力/基本人类介入。技术支撑：平台解耦。未来功能不等同装饰：网页和集成可能提升核心体验，但非本轮前置。QoL：收藏/排序/头像/分享样式。Raft官方生命周期描述人类创建Agent，不能从action prepare推断无限自主spawn。
