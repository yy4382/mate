# E2b2c canonical领域、存储与生产切换

状态：独立红队复审PASS。不得视为E2或首版完成。

审核者：独立只读subagent `/root/review_e2b2c_canonical`；未参与实现。依据AGENTS软件工程/产品语义要求，检查实际diff与故障路径。第一轮独立106项定向验证通过，并额外复现P1：Slack history普通消息丢失edited.ts，导致离线编辑不更新。已在protocol与normalizer修复并加canonical-adapter回归。

工程修复：同行不可变outbox路由、可变JSON表达式索引，删除v17过渡镜像表及全量JS检查；旧writer移至测试fixture；生产仅一套canonical路径。审核者已检查实际实现并通过工程门槛。

本地：Node24.13.0/pnpm，220通过、7真实环境测试跳过（含历史fixture回归，不全是新canonical场景）。新canonical作用域/原hash/旧echo/history编辑/route约束5项运行生产services+Slack adapter、模拟HTTP；非真实Slack/provider/VPS测试。另有精确revision、unknown-root补全、重复delivery状态、原wire字节、事务回滚、跨重开、工具/任务/提醒/附件/独立review seat与选择空间回归。

保留范围：参与规则mute/DM差异在E3；内部DM原子提交/local adapter/config解绑在E2c；VPS隔离与部署V1–V3。当前不提交到远端、不部署、不发送Slack。

复审补充：将原Slack消息测试也切到生产canonical实现；已测试系统回执/同行echo、429及internal_error、身份对账、撤权和notice合并。Slack文本对账按[官方格式说明](https://docs.slack.dev/messaging/formatting-message-text/)处理已知裸URL、实体及标准emoji表示；使用锁定的@emoji-mart/data 1.2.1别名/肤色数据，未知自定义内容不猜测。保留真实message.text；原hash、作者、目标和已派发状态仍必须匹配。附件echo使用同一适配层注入的等价规则，避免格式转换造成双计未读。

最终复审：P2实体解码误将escaped literal与active mention判为等价；改为结构化text/control分段后规范化，增加双向负例和同active正例。审核者复核112项定向测试，最后修复另验47项，结论PASS，无剩余验收阻碍。此结论不覆盖后续E2c/E3/VPS。
