# Mate harness 验收

2026-09-21。假设模型足够智能，验证它的合理选择是否可执行、可观察、可恢复；不评测模型主动性或协作质量。各模块独立红队gate见[实施计划](IMPLEMENTATION_PLAN.md)。[当前调用链](HOW_IT_WORKS.md)解释具体函数与剩余差异。

## 产品语义与证据

| 能力/选择 | 当前验证 |
|---|---|
| 一Agent跨channel/thread/DM连续，peer独立 | runtime/supervisor：真实worker进程、同session/PID和独立环境；slack/conversations：顶层目标/DM发现与对账 |
| 主动感知、暂缓、沉默 | attention：seen/resolve/defer/mute分离、分页ACK、晚到/编辑/删除；Engine通知在模型边界进入持久输入，不强杀工具 |
| 同一变化下的多种合理决策 | daemon/integration五种真实Pi loop分支：defer保留、discard静默、continue、revise后发送、重读retry；无task tree；continue不推进seen |
| 预配置团队和本地实验入口 | daemon/experiment-release：Slack/local示例共享平台无关Agent定义；真实Daemon让同一输入下一个成员显式发言、另一个保持沉默；local JSONL复用同一服务和持久库 |
| 消息任务而非重复任务对象 | coordination/messages：canonical message_key、并发owner CAS、held无提前副作用、unclaim/transfer/update；创建可见消息confirmed后激活 |
| 同伴直接讨论与证据修订 | daemon/integration：A认领原始消息、B直接反馈、A更新；peer可凭已有账户唤醒，无必需人类预算根 |
| 跨事项选择 | supervisor：读取/切换独立；run成本仍归起始事项；selected work暂停/恢复与账户债务保持 |
| 灵活私有workspace | execution/policy：目录、搜索、编辑、移动、删除、exec、root和双路径检查；真实SRT Unicode/二进制往返 |
| 当前work能力可发现 | capabilities/environment：effective grant、稳定label、relative path、无Docker/adapter、撤销/过期/切work/review seat；报告只读且不是授权token |
| 附件作为输入和可见成果 | daemon/attachments、slack/freshness：正式ToolRouter贯通acting identity、可见message/fileId、文件处理、冻结/revise/continue、分享前重查、unknown fileId对账、echo去重 |
| 作者提醒独立于task完成 | reminders：内容/锚点/version、改期/取消/log、只唤醒作者、任务结束后仍触发、漏期合并、pending与已选中区分 |
| 受控更换context，身份不断 | supervisor：model reset after-run/recovery、owner reset留paused、旧view失效、未知动作/债务/任务/提醒保留；跨session自身执行receipt可查 |
| 角色/工具/配置演进 | daemon/migration：旧配置匹配、身份不可重绑、备份、事务回滚、pending reset一次应用、四Agent本地启动、撤销grant保留 |
| 完整行为prompt与memory恢复 | runtime/prompt对照产品方向/参考材料独立审查；Engine/真实IPC压缩后刷新最新memory/checkpoint，失败不继续用旧包 |
| 独立review seat | supervisor/policy：unused身份+clean workspace、对话/peer路径统一屏蔽、私有文件/离线exec、opaque held后continue |
| 持续预算与公平性 | Agent账户不随新消息/work/reset补额；work耗尽不暂停全Agent；reminder触发与outbox筛选先排除阻挡再LIMIT，无关事项可前进 |

测试位置：上述名称均位于[tests](../tests/)，具体断言可检索对应能力。所有数据均为合成fixture，不使用私有Raft memory。

## 故障矩阵

| 窗口/故障 | 预期及测试证据 |
|---|---|
| Slack重复/乱序、commit后ACK前断开 | ingress持久去重；本地revision独立于Slack时间；编辑/删除/晚到回归 |
| 工具执行后、toolResult journal前崩溃 | action receipt原子保存；transcript修复显式历史回执，不能盲重放 |
| notice收到但正文未ACK、分页不完整 | 不推进完整view/seen；重启或epoch变化需要重新呈现或明确continue |
| send排队后讨论变化、429后变化 | dispatch重新hold，草稿保留；不是悄悄发送旧意见 |
| 外部调用回执丢失 | unknown持久、同目标后续阻挡；消息/附件按明确Slack证据对账；无凭据不猜成功 |
| 上传已allocation但尚未share | fileId/phase落盘；分享前再检查；未开始share可判失败，sharing不确定保留unknown |
| 一个频道有大量被阻挡输出 | unknown/相关ingress在ready LIMIT前过滤；其他频道仍可派发 |
| 作者预算/ACL/事项阻挡一批提醒 | tick在LIMIT前筛选；其他合法作者仍可触发 |
| owner stop/cancel、daemon死亡 | generation fence、worker abort、容器PID namespace清理、文件helper lifeline；resume不清债务 |
| reset请求后run中断、owner reset与旧run收尾交错 | 一次轮换、取消不续跑、暂停保持；不覆盖新session |
| 配置迁移事务写失败 | 旧配置/session/grants一致保留，已有完整备份；保守fenced recovery不回滚为active |
| 压缩后memory刷新失败 | 先失效view，再失败；真实RPC验证无主推理、无使用旧包冒充当前 |

## 本地验证与外部边界

普通检查的当前精确数量记录在最新模块review；默认跳过7项需要显式本地SRT/Docker权限的测试。真实隔离集曾单独执行7/7通过；详见对应review记录。

普通集调用真实Pi loop、Node worker与IPC，Slack/provider采用合成transport。真实隔离集使用现有固定本地镜像，覆盖跨root/secret/network、停止/超时/daemon死亡、二进制及network策略；不拉镜像、不连接外部服务。

未进行真实Slack/provider验收。上线前核对安装身份/scopes、频道及DM事件、bot echo、429、unknown对账、附件分享、provider usage/错误格式与停止时延；逐项步骤见[实验运行手册](EXPERIMENT_RUNBOOK.md)。这些是协议接线与运行契约，不是证明模型能自发作出相同决策。

当前边界详见[HOW_IT_WORKS](HOW_IT_WORKS.md)：本地freshness不是Slack全局原子事务；没有通用search/browser/第三方登录；review seat为更保守的全对话隔离；大小/分页/单run输入有界；没有通用unknown强行清账；单daemon/workspace，其他OS未验证。

## 独立审核轨迹

每个模块通过后才实施后续模块：[R1a/R1b–R7c记录](reviews/)。R7a红队发现并修复旧unknown不可查和历史回执ACL旁路；R5/R6发现并修复adapter seat旁路、UTF-8分块损坏、附件ACK/echo竞态、提醒批次饥饿。R8补充outbox公平性及多分支语义验证。最终gate和确切测试数记录在[R8审核](reviews/R8-product-semantics.md)。

未推送、部署、创建外部资源或发送真实Slack消息。
