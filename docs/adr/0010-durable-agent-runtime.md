# 由 Pi Durable 推进 Agent，以各自事实拥有者恢复

Mate 的持续工作、消息注意力和远程副作用需要可靠恢复，但无需维护另一套通用模型引擎。控制面采用锁定的 `@earendil-works/pi-durable@1.1.0`、匹配的 `pi-ai` 与 Chord 公共接口。它取代直接使用 pi-agent-core 推进循环、旧 transcript 权威表与读取器、手工工具续接和移植 Pi 0.86 压缩算法；不使用 pi-coding-agent，也不保留双写、切换或回退。

一个 Agent 拥有唯一主 conversation 和同库的工作助手 conversation；一份 Harness 推进整组，关闭完成后才能打开替代实例。助手有独立模型上下文和 provider session，复用所属 Agent 的业务身份与节点环境，不成为新成员。原生 background task 持有助手工作并向最初委派者幂等提交结果；主输入结束不关闭仍有助手工作的 Harness，新消息仍可进入原主会话。Durable 保存输入 requestId、模型经历、工具 task 检查点、重试、压缩和原生用量；文件在控制面私有数据目录 `durable/<Agent ID>.sqlite`，使用 WAL 与 `synchronous=FULL`。Mate 业务库保存身份、暂停意图、频道/消息/注意力、任务、提醒和外部操作事实，只关联原会话、输入确认、工具来源 conversation 和持久工具 task；节点拥有本机操作收据。输入接收、正文实际呈现、已读、暂缓和投递处理保持分别可观察；内部 task 不建立协作层级或权限。

完整调用持久化后才进入业务工具。持久 task 身份绑定工具及输入，已完成返回既有结果；已开始但未知的效果提供事实，不盲目重做。运行资格在实际 provider 入口和业务事务复查；暂停或节点离线撤销资格并关闭 Harness，排队工作留在原库。配置改变或必须先提供恢复事实时，原生终止后在同一会话重新准入；未知及迟到收据更正回到实际发起操作的 conversation，空闲助手可由原生后台任务唤醒；旧运行不重新获得资格。业务已读与每个 conversation 的实际呈现分开，助手读取不能清除主会话的 freshness 检查。普通请求退避和容量触发的阻塞压缩由 Durable 完成，关闭后台预压缩；Mate 只重新准入已经终结但仍未处理的业务投递。

保留 [ADR-0005](0005-faithful-agent-context-replay.md) 的历史完整性、实际请求前缀与可观察统计原则，以及 [ADR-0007](0007-continue-with-uncertain-operation-results.md) 的未知效果继续工作原则。压缩不删除原始历史；失败响应、流式进度与工具用量按原生含义读取，不能伪装成已确认历史或普通请求用量。缺失统计保持未知，不设 token/费用/run 额度。

控制面与 node 的职责和 [单账号](0004-single-account-command-execution.md)/[有限 Linux 包装](0009-lightweight-linux-packaging.md) 边界不变，整个控制面数据目录纳入原挂载与保留规则。按 [ADR-0002](0002-first-release-compatibility-reset.md) 拒绝旧开发库和旧检查点，不迁移或覆盖；新版本自身的重启、同版本更新与保留数据卸载沿用原身份、会话与工作区。完整规格见 [#229](https://github.com/yy4382/mate/issues/229) 与工作助手 [#236](https://github.com/yy4382/mate/issues/236)。
