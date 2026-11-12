# 连接器与 Agent Manager 边界测试

> 这个模块的设计见同目录的 [ARCHITECTURE.md](ARCHITECTURE.md)。所有模块共用的测试规则和替身见 [docs/MODULE_TESTS.md](../../docs/MODULE_TESTS.md)。

## 1. 连接器

**边界：** 输入是聊天 app 的 `inboxEvents` 和 `unreadSummary`，输出是对 runtime 的 `submit` 和 `withdraw`。

**替身：** 测试连接器时，用真实聊天 app 加上一个记录 `submit` 和 `withdraw` 的假 runtime；验证与 Durable 的组合时，用真实 runtime 加故障存储适配器。

- 一条新收件事件产生一条通知，`requestId` 是 `notice:<事件 ID>`，`whenBusy` 是 `steer`。
- 通知文字写明时间点、"至少"多少条、各时间线的条数、是否 @ 了你，以及"之后可能还有更多"。
- 已有一条通知还没交给模型时，又来了新事件：旧通知被撤回，新通知反映最新状态，模型最终只看到新的那条。
- 撤回时旧通知恰好已经交给了模型：新通知仍然照常提交，模型先后看到两条。
- 提交通知之后、保存事件位置之前崩溃：重启后重新提交同一个 `requestId`，模型只看到一次。
- runtime 关闭期间来了很多事件：重新打开后只产生一条通知，数字反映全部未读。
- 只有任务条目变化、没有新消息时，不产生通知。

## 2. Agent Manager

**边界：** `AgentManager` 接口和 `data/agents/` 目录。

**替身：** 真实聊天 app、真实 runtime、假的工作区宿主（按 node 和 Agent 记下准备和调用）、脚本化提供商。经真实网关和假 node 的部分（node 必须已配对、暂停停掉 node 上的命令）在 [packages/admin/TESTS.md](../admin/TESTS.md)，因为把网关接成工作区宿主的是管理模块。

- 创建 Agent 后，聊天 app 里有对应账号，node 上有工作目录，`data/agents/` 里有它的文件。
- 工作目录只建在创建时选的主 node 上；Manager 仍把端口绑定到该主 node，每次调用的访问目标由管理模块解析。
- 重启后、暂停再恢复后，Agent 都接到创建时记在它文件里的 node。
- `describe` 对打开的和暂停的 Agent 给出同样的 node、设置和用量，只有状态不同。
- 暂停的 Agent 也能改设置；恢复后第一次模型请求就用新设置。
- 创建流程在改名之前的每一步之后中断，重做一遍都能得到完整的 Agent，不会出现两个聊天账号或两个文件；聊天 app 拒绝的创建（handle 被占用）原样拒绝，不算要重做的创建。
- 用已存在（打开的或暂停的）或已删除的 Agent 的 ID 创建被拒绝，名字、状态都不变；文件到位之后 runtime 打不开，Agent 保持关闭并被报告，`resume` 打开它。
- 文件改名之前中断：Manager 重启后看不到这个 Agent。
- 重启后，Manager 打开所有没有暂停的 Agent，跳过已暂停的。
- 对同一个 Agent 并发调用暂停、恢复、暂停，最终状态和这些调用按到达顺序依次执行的结果一致，并且任何时刻最多只有一个已打开的 runtime。
- 暂停后：模型请求被中止，node 上的工具调用被停止，之后发来的消息不会让模型被调用；恢复后，模型看到暂停期间累积的通知。
- 暂停状态在控制面重启后仍然保持。
- 删除 Agent 后，它的文件不存在，聊天账号被停用，它过去发的消息仍然可读。
- 一个 Agent 的存储文件损坏，其他 Agent 照常启动和工作。
