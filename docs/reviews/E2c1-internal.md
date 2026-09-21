# E2c1 内部通信与本地入口

状态：独立红队复审PASS。本地229 tests通过、7环境测试跳过。

实现前设计讨论：review_e2b2c_canonical，接受分c1/c2/c3独立gate，要求authority分流、内部事务完全提交、工作归属可运行、pair唯一/撤权不恢复、旧openDM原路由、review seat隔离和生产最小接线。约束已写入ARCHITECTURE。

代码审核者：独立新上下文 `/root/review_e2c1_internal`，只读，未参与实现。范围：InternalMessages、TeamDirectory、LocalAdapter/application、schema18/空库bootstrap、Output接线、生产Slack轮询/目录及离线迁移。tests/conversations/internal.test.ts使用合成身份，无Slack/provider网络。

验证：反向打开同一DM、同ID变参、撤权重试、事务内delivery_work故障回滚、重开后固定messageId/无重复唤醒、local human幂等输入与真实Supervisor调度/独立预算、peer输入对review seat及重启恢复不泄漏、Slack轮询不处理内部ID、未实现内部attachment/projection拒绝且无intent。

本gate不包含c2外部projection、c3配置拆分、不把模拟worker当真实provider、不代表VPS已部署。

初审P1：Freshness.revise绕过Output能力验证，可使internal artifact永久pending；现抽取output-intent统一校验，revise失败保留原held且不生成新输出。P2：暂停work拒绝human新输入；现允许可信human持久化，scheduler仍暂停，Agent输出仍要求active。

最终审核：review_e2c1_internal独立全套初版227/7skip，修复后相关11项及三条独立复现通过，明确PASS，无剩余阻碍。工程边界/迁移/工作归属/旧动作路由与隔离符合设计。非阻塞后续：组合目录外部故障不应遮蔽内部spaces，c3返回内部结果+external incomplete；内部openDM/read/send不受影响。
