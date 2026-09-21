# E2c2b Slack 双向展示接线

状态：独立红队复审PASS。完整245项通过，7环境测试跳过。

审核者：新上下文只读 `/root/review_e2c2b_slack_projection`；未参与实现。基线213dacf。独立Slack projection修复后7项及内部/投影/旧adapter/迁移32项通过。

实现：schema20独立导入依赖表、单调外部revision与canonical原子事务、多App去重/来源binding防反射；Slack HTTP/echo原hash+身份+目标+内容确认；副本编辑/删除只drift；暂停输入继续持久化。production启动/轮询/恢复/管理接线，旧schema显式offline迁移。新绑定仅向前，允许import的人类须显式内部成员；添加不授全历史read。

初审P2验收阻塞：100条管理记录生成20528字符，经过真实SlackService.replay统一15000字符截断后丢失nextCursor。已改Slack专用controlPage，完整JSON最多12000字符且最多20条，严格before分页；新增真实replay→admin_replies验证。其他新增管理列表同样有界。复审认定阻塞解除，无其他正确性/架构阻碍。另补projection_reconciliation_gap记录页数上限。

验证范围是本地应用服务+模拟Slack HTTP/事件；没有发送真实Slack消息、部署或创建外部资源。真实身份/scopes/provider协议留给连接验收。完整配置解绑仍属E2c3。操作及明确限制见PROJECTIONS.md。
