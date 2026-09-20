# R6 作者拥有的提醒 — PASS

基线3b4b7a4。独立只读reviewer /root/review_r6，fresh context，初审FAIL，修复后复审PASS。未参与实现，另作临时合成复现。

范围：reminders内容/target/可选anchor/task/version、CRUD/log与分页；作者身份独立于任务owner和任务完成；持续Agent账户+原事项cap；取消未来与撤回pending/已选中及已注入区分；cron漏过合并；原子delivery/firing/log/固定可见receipt；v14备份迁移。

检查：实现者pnpm run check 156通过/7真实隔离默认skip；reviewer独立全套同结果，额外2个合成边界测试通过。未变更backend，不重复真实容器检查，不发送Slack。

发现与修复：
- P1：LIMIT100后才过滤ACL/预算，100个不可触发提醒会永久饿死另一作者。候选SQL先过滤ACL、持续Agent预算、事项预算；三种饥饿回归通过。
- 非阻塞改进也完成：reminders.list按rowid before游标分页，tools.call返回nextCursor，较旧提醒仍能发现。
- inFlight报告独立于最近100个firing展示窗口；selected但尚未injected视为运行中，不撤回、不伪称取消。显式cancelPending撤回全部可撤pending，返回总数及最多100个ID。
- 固定回执的早到Slack echo校验作者/hash/text/channel/thread/projection，不唤醒peers；模型正文不进入自动通知，只给作者inbox。伪造metadata仍作为普通输入。

迁移保留原ID/时间/active，不擅自重新启用旧任务完成时已取消的提醒；legacy内容明确为推断占位，作者可编辑。旧schedules.create为兼容目的占位，新reminders.create必须给content；legacy工具取消也需要version。事项pause/cancel仍控制其提醒，任务done/cancelled/failed本身不取消提醒。无剩余阻塞。
