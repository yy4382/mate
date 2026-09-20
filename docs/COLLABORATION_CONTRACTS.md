# 协作与调度边界

所有身份/work 参数由可信 daemon 或后续 broker 绑定。模型不能创建 budget root，也不能用文本中的 owner 声明控制任务。

- work 根从可信人类 ingress 幂等创建；子任务、发送、同伴 delivery、schedule 继承同一 work。消息与work关联使用 daemon 表，不读取聊天正文。
- budget 在模型执行前 reserve；计入最大 run 数与最坏 token/费用额度。已知 usage 只结算一次；崩溃未知usage不退预留，避免重启刷新预算。超过预留的真实用量仍记账并暂停。F 必须限制实际模型循环不超过预留，D 不声称已拦截模型请求。
- task 认领用条件 UPDATE，仅一个 owner；被指派任务只供对应 Agent 认领。waiting 保留owner，依赖闭环被拒；依赖终止与唤醒原子提交。完成需结果/证据且无未完成子任务。
- 委托先创建 draft 与明确 Slack 输出；sent 后才todo并投递。unknown 发送不会激活工作，也不会自动重发。
- 明确发送失败的draft终结为failed并原子唤醒等待者；创建者可撤销未激活委托。依赖检查同时遍历显式wait与父完成对子任务的隐式依赖。
- schedule 一次性/cron+时区，tick 同事务 enqueue 与推进；离线合并一次catchup；取消任务关闭关联schedule。改期不越过已终止任务或停止work。
- owner 控制只接受配置中的人类ID；暂停work使旧run失效，输出停止发送，其他work仍可调度。返回run ID供F/G中止进程。cancel不可恢复；resume不增加预算。

后续 F/G 负责把待处理人类消息绑定work、模型调用预算、工具参数上下文、真实停止通道和状态输出。本模块测试为本地合成事件，不代表自主模型协作已运行。
