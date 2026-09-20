# Mate 本地交付验收

> 以下是旧实现的机制测试记录，不是新产品定位的验收。重新定位后必须按[PROJECT_DIRECTION](PROJECT_DIRECTION.md)验证完整可达行为；当前消息门控等改造未实现。

2026-09-20。模块A–G按依赖顺序实现，每个模块通过独立红队后再继续；本次H也通过独立review_h审核。最终状态以 [实施计划](IMPLEMENTATION_PLAN.md) 和 [逐模块记录](reviews/) 为准。

| 验收项 | 本地证据 | 外部待验 |
|---|---|---|
| 一个Agent跨频道同session、不同Agent隔离 | 真实Node子进程+合成provider；会话、PID、环境隔离断言 | 真实Slack多频道/DM与provider |
| 持久输入/工具屏障/重启 | SQLite commit-before-ack；Pi await journal；副作用已提交但toolResult缺失窗口不重放 | Slack真实重复/延迟事件 |
| 自主协作与成果修正 | 真实Pi loop驱动A委派、B反证、A读取任务结果并修订；只有一个work预算 | 协作工具、事件与Slack权限的真实接线 |
| 授权和停止 | scope内直接执行、任务等待释放、owner控制；容器setsid、abort、timeout、重启清理 | Slack交互、长任务真实stop时延 |
| 执行隔离 | macOS SRT实际文件操作；固定本地镜像容器无网络/秘密/跨root读写；daemon死亡文件助手退出 | 其他OS；实际项目工具链镜像 |
| 压缩恢复 | Pi官方summary helper经同一预算边界；超长历史分块、完整tool边界、snapshot事务 | 真实provider协议与usage账单兼容 |
| 备份与单实例 | 内核flock；SQLite backup API+memory一致检查点；测试重新打开备份库并比对memory | 用户正式备份位置与完整恢复演练 |
| Slack服务 | 固定SDK契约、本地缓存ACL/变更、outbox unknown不重发、replies补抓、gap记录 | scopes/安装身份/实际速率限制、bot echo |
| 命令审查 | 按用户要求移除Jev与逐命令审批；scope/grant/隔离保留 | 不属于当前待验服务 |

最终普通检查：`pnpm run check` 编译成功，66 passed，4项需要显式本地权限的真实隔离测试默认skipped。4项隔离测试已通过 pnpm 单独实际重跑，全数通过。模拟provider/Slack不产生付费模型调用或真实消息。

已知产品边界：固定1–3个Agent；研究是allowlist URL读取，无全网搜索；成果发布为自有artifacts/下64KB文本；搜索仅本地已可见Slack缓存；静态配置策略变化需要显式迁移，不静默扩权；命令审查已移除。当前凭证缺失，未把真实服务协议接线标为已验。

入口和配置见 [README](../README.md) 与 [mate.example.json](../mate.example.json)。开发过程中未推送、部署、创建外部资源、读取私有memory写入fixture或发送Slack消息。

2026-09-20补充：A–G测试数为历史基线；本次移除废弃审查测试、补充v7迁移与直接执行测试。原始v1的未接通功能和harness能力可达性缺口见[HOW_IT_WORKS](HOW_IT_WORKS.md)，模块PASS不等于所有产品feature均已完成。

验收范围按用户最新指示：假设模型足够智能，只评估harness工具、环境、prompt、调用链和状态恢复。模型表现/协作质量不属于本阶段目标或交付阻塞。
