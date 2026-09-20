# Mate 本地交付验收

2026-09-20。模块A–G按依赖顺序实现，每个模块通过独立红队后再继续。最终状态以 [实施计划](IMPLEMENTATION_PLAN.md) 和 [逐模块记录](reviews/) 为准。

| 验收项 | 本地证据 | 外部待验 |
|---|---|---|
| 一个Agent跨频道同session、不同Agent隔离 | 真实Node子进程+合成provider；会话、PID、环境隔离断言 | 真实Slack多频道/DM与provider |
| 持久输入/工具屏障/重启 | SQLite commit-before-ack；Pi await journal；副作用已提交但toolResult缺失窗口不重放 | Slack真实重复/延迟事件 |
| 自主协作与成果修正 | 真实Pi loop驱动A委派、B反证、A读取任务结果并修订；只有一个work预算 | 真实任务质量，与Raft体验比较 |
| 审批和停止 | 固定参数/前置条件、等待释放、owner控制；容器setsid、abort、timeout、重启清理 | Slack交互、长任务真实stop时延 |
| 执行隔离 | macOS SRT实际文件操作；固定本地镜像容器无网络/秘密/跨root读写；daemon死亡文件助手退出 | 其他OS；实际项目工具链镜像 |
| 压缩恢复 | Pi官方summary helper经同一预算边界；超长历史分块、完整tool边界、snapshot事务 | 真实provider摘要质量/用量账单 |
| 备份与单实例 | 内核flock；SQLite backup API+memory一致检查点；测试重新打开备份库并比对memory | 用户正式备份位置与完整恢复演练 |
| Slack服务 | 固定SDK契约、本地缓存ACL/变更、outbox unknown不重发、replies补抓、gap记录 | scopes/安装身份/实际速率限制、bot echo |
| Jev | 官方TypeSafe SDK、脱敏、失败关闭，分类不扩权 | 中文校准、延迟与误判率 |

最终普通检查：`npm run check` 编译成功，68 passed，4项需要显式本地权限的真实隔离测试默认skipped。4项隔离测试已另外实际运行通过（原3项一组，新增daemon崩溃1项一组）。模拟provider/Slack不产生付费模型调用或真实消息。

已知产品边界：固定1–3个Agent；研究是allowlist URL读取，无全网搜索；成果发布为自有artifacts/下64KB文本；搜索仅本地已可见Slack缓存；静态配置策略变化需要显式迁移，不静默扩权；Jev保持shadow。当前凭证缺失，未把真实服务或协作质量标为已验。

入口和配置见 [README](../README.md) 与 [mate.example.json](../mate.example.json)。开发过程中未推送、部署、创建外部资源、读取私有memory写入fixture或发送Slack消息。
