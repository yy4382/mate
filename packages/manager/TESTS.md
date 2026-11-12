# 连接器与 Agent Manager 边界测试

> 这个模块的设计见同目录的 [ARCHITECTURE.md](ARCHITECTURE.md)。所有模块共用的测试规则和替身见 [docs/MODULE_TESTS.md](../../docs/MODULE_TESTS.md)。

## 1. 连接器

**边界：** 输入是聊天 app 的 `inboxEvents` 和 `unreadSummary`，输出是对 runtime 的 `submit` 和 `withdraw`。

**替身：** 测试连接器时，用真实聊天 app 加上一个记录 `submit` 的假 runtime（记下输入的 requestId、内容、`whenBusy` 和 `replaces`）；验证与 Durable 的组合时，用真实 runtime（装入聊天插件）加故障存储适配器。

- 一条新收件事件产生一条通知，`requestId` 是 `notice:<事件 ID>`，`whenBusy` 是 `steer`，`replaces` 是 `notice:`（撤回未交付的旧通知）。
- 通知文字写明时间点、"至少"多少条、各时间线的条数、是否 @ 了你，以及"之后可能还有更多"。
- 已有一条通知还没交给模型时，又来了新事件：旧通知被撤回，新通知反映最新状态，模型最终只看到新的那条。
- 撤回时旧通知恰好已经交给了模型：新通知仍然照常提交，模型先后看到两条。
- 提交通知之后、保存事件位置之前崩溃：重启后重新提交同一个 `requestId`，模型只看到一次。
- runtime 关闭期间来了很多事件：重新打开后只产生一条通知，数字反映全部未读。
- 只有任务条目变化、没有新消息时，不产生通知。

## 2. 聊天插件

**边界：** 真实 runtime（经 `chatPlugin`）发给模型提供商的请求，和发给真实聊天 app 的调用。

**替身：** 真实聊天 app、真实 runtime 加故障存储适配器、脚本化提供商。因为 `openAgentManager` 不暴露存储适配器，这里直接打开 runtime，由 `chatPlugin(account)` 装入。

- 主对话的系统提示说明普通输出不会发到任何地方、发言要调用 `chat_send`、通知只是提示。
- 模型的最终文字不会被发到任何聊天会话，也不通知任何人。
- 模型读过之后别人又在这条时间线上写了东西，`chat_send` 被拦下：结果是 `held`，带上模型错过的条目；原样重发或修改后重发都放行，频道里只有重发的那条。
- `chat_send` 在执行中崩溃（聊天 app 已经发出消息，但工具结果还没提交），重启后重新执行，聊天 app 按 `requestId` 原样返回结果，频道里只有一条消息。
- `chat_read_unread` 在同样的位置崩溃，重启后模型拿到的正是第一次读到的那一页。
- 工具调用的 `requestId` 来自 Durable 的工具调用 ID，而不是提供商的调用 ID：两次独立的工具调用即使提供商给了相同的调用 ID，也各自执行。
- 聊天 app 的拒绝作为带原因的错误结果交给模型，运行继续。
- 工作助手没有聊天工具：脚本化提供商让助手强行调用聊天工具名时，调用失败，聊天 app 没有收到任何调用。

## 3. Agent Manager

**边界：** `AgentManager` 接口和 `data/agents/` 目录。

**替身：** 真实聊天 app、真实 runtime、假的工作区宿主（按 node 和 Agent 记下准备和调用）、脚本化提供商。交来的插件（如 webhook）装进每个 Agent，由交插件的模块测，见 [packages/admin/TESTS.md](../admin/TESTS.md)。经真实网关和假 node 的部分（node 必须已配对、暂停停掉 node 上的命令）在 [packages/admin/TESTS.md](../admin/TESTS.md)，因为把网关接成工作区宿主的是管理模块。

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
