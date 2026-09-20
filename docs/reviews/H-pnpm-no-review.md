# H — pnpm、移除命令审查与 harness 调用链（PASS）

基线 `1f1abea`。范围：pnpm/Node工具链、依赖与lockfile、Jev/审批删除、Broker直接scope执行、v7持久状态迁移、配置/控制入口/工具投影、当前调用链和能力边界文档。旧A–G审核记录保留为历史。

## 要求与实现

用户新指令覆盖旧交接稿的Jev要求。删除官方SDK、分类器、审批控制/通知、retry工具、命令白名单及活动审批表；保留有效run/work/grant/path校验、动作hash/回执、未知副作用不重放、ExecutionBackend注入、容器与文件沙箱。

v7将旧exec grant撤销，prepared exec终止，待发审批通知取消，最小旧审批审计归档；会话、journal、tasks与unknown动作保留。历史schema仅用于数据库升级，不是活动审查实现。runtime/session配置hash仍需显式迁移，不承诺旧配置无缝启动。

验收假设模型足够智能，只检查harness的工具、环境、prompt、可达行为与持久恢复。脚本化模型用于确定性验证机制，不把模型智能或自发协作质量作为问题。

## 本地验证

- 移走旧node_modules后，`pnpm install --offline --frozen-lockfile` 全新安装通过。
- pnpm10.33.0固定；pnpm托管Node24.21.0，SQLite查询和fs-ext原生模块加载通过。
- `pnpm run check`：编译成功，66 passed / 4 skipped。
- 实现者单独实际运行 `pnpm test tests/execution/sandbox.test.ts`（启用MATE_SANDBOX_TEST并指定已有本地镜像/socket）：4 passed，包含文件/容器隔离、setsid与正常/abort/timeout清理、重启清理、daemon死亡连带停止文件助手。没有拉镜像、调用外部provider或发送Slack消息。
- 新增实际v6 SQLite fixture→v7迁移回归；scope内exec直接运行、回执复用及越界/撤权/停止/unknown保留验证。

## 独立审核

独立reviewer `/root/review_h`，fresh context、read-only；获提供基线、要求、实际文件与测试结果，要求核对真实代码、迁移/失败路径及文档可达性。独立运行 `pnpm run check`：66 passed / 4 skipped，`git diff --check`通过。另建临时v6合成库验证：executing动作和sending审批通知在迁移时保留不确定性，恢复后转unknown；既有unknown回执原样保留、exec grant撤销、foreign_key_check无异常。临时数据已清除。reviewer未重跑4项真实隔离测试；本轮由实现者重跑通过。

结论：无critical/high或验收阻塞，PASS。低优先建议为README真实接线措辞可能被理解成模型质量门槛；已改为预定合成动作验证机制，真实provider只验协议/usage/errors，不评测协作决策和成果质量。

同一独立reviewer已复核README修正，确认建议解决；最终PASS，无未解决发现。
