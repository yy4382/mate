# Agent Manager 和连接器（`@palace/manager`）

> 总览见 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)。测试见 [TESTS.md](TESTS.md)。

## Agent Manager

### 职责

管理所有 Agent 的 runtime。Manager 是唯一能打开 runtime 的地方。

### 接口

`openAgentManager({ directory, chat, workspaces, credentials, plugins?, clock?, report? })`，签名在 `src/index.ts`。

- `workspaces` 是 `WorkspaceHost`：`prepare(nodeId, agentId)` 准备工作区，`port(nodeId, agentId)` 返回工作区端口。生产环境由管理模块把 node 网关接进来。
- `plugins` 是管理模块等调用方交来的插件，装进每个 Agent 的 runtime，排在聊天插件之前。Manager 给每个 Agent 装同一组插件。
- `report(error, agentId)` 接收打不开的 Agent、出错的连接器和存储失败的 runtime，不让进程崩溃。
- `AgentManager` 提供 `list`、`create`、`delete`、`pause`、`resume`、`describe`（`open`、`paused` 或 `closed`）、`configure`、`runtime(id)` 和 `close`。生命周期操作都返回 Promise，ID 不合法时 reject。

### 规则

1. **一个 Agent 存在，当且仅当 `data/agents/<id>.sqlite` 存在。** 启动时扫描目录，打开所有没暂停的 Agent，没有另一张 Agent 列表。只有名字正好是 `<UUID>.sqlite` 的文件才算，临时文件（`.creating`）和 SQLite 附属文件不算。

2. **同一个 Agent 的生命周期操作串行执行**，每个 Agent 一条队列，所以一个 Agent 最多只有一个打开的 runtime，不需要检查。

3. **暂停就是立刻关闭。** 进行中的模型请求被中止，node 上的工具调用被停止。恢复时 Durable 从停下的地方继续。不存在"还在跑但已经没资格跑"的状态。

   Manager 对每个 Agent 只记打开（runtime、连接器和从文件读出的 node ID）或关闭。Agent 文件里的内容（是否暂停、node ID、设置、用量）只在关闭状态下直接读写，因为直接读写会在文件上另开一个 Durable 会话，和打开的 runtime 并存会弄坏存储。打开的 Agent 一律经 runtime 读写。所以对打开的 Agent 调 `resume` 什么都不做，对关闭的 Agent 调 `pause` 只写记录。

4. **创建的顺序：**
   1. 使用调用方传入的 Agent ID，或生成一个。
   2. `chat.ensureAccount({ externalId: agentId })`，可以安全重复。聊天 app 的拒绝原样 reject，这时什么都还没创建。
   3. 让所选 node 准备工作区。
   4. 在临时文件里初始化 Durable 存储（带 node ID），再改名为正式文件。

   改名是最后一步，所以 Agent 要么完整存在，要么不存在。步骤 3、4 失败时 reject 的 `AgentCreationFailed` 带着 Agent ID，调用方把它传回 `create` 重做。每一步都可以重复，所以重做得到同一个 Agent、一个账号、一个文件。不带 ID 重做会生成新 ID，而旧 ID 的账号仍占着 handle。

   已存在的 ID 以 `AgentIdInUse` 拒绝，什么都不改。改名之后 runtime 打不开时，Manager 报告错误，`create` 照常返回，Agent 处于关闭状态，`resume` 可以再打开它。

5. **打开一个 Agent：** 从文件读是否暂停和 node ID，暂停了就不打开。用 `chat.findAccount(agentId)` 找到账号，用 `forAccount` 的结果造这个 Agent 的聊天插件；用 `workspaces.port(nodeId, agentId)` 得到工作区端口；打开 runtime（装入 `plugins` 和聊天插件），再挂上连接器。node ID 之后不变，端口自己解析每次调用的可选目标 node。

6. **删除的顺序：** 关闭 runtime，停用聊天账号，最后删除文件。中途失败时 Agent 仍然存在，重做即可。

7. **runtime 死了，Agent 就关闭。** runtime 存储出错（`onFatal`）时，Manager 报告错误，并在这个 Agent 的队列里停掉连接器、关闭 runtime。Manager 不自动重开，因为同样的故障多半会让重开再次失败。它没被记为暂停，所以 `resume` 或下次启动会重新打开，Durable 从已提交的地方继续。

## 聊天插件

### 职责

Agent 的聊天能力：聊天工具、告诉模型怎么发言的系统提示，以及未读通知的渲染。三者在 `src/chat-plugin.ts` 一处，通知的文字和它指向的工具 `chat_read_unread` 在同一个文件里。插件名是 `chat`（作用范围只有主对话，工作助手没有聊天工具）；名字存在助手对话的配置里，不能改。

### 规则

1. **聊天工具只通过账号视角调用聊天 app。** `chatPlugin(account)` 接收 `ChatApp.forAccount` 的结果（`AccountChat`）。聊天 app 不知道 runtime，runtime 也不知道聊天 app，只有 Manager 同时认识两边。工具的参数是模型给的参数加上 `requestId = tool:<Durable 工具任务 ID>`，结果原样转成 JSON 交给模型。发送和任务操作总是带 `freshness: true`，模型参数里没有这一项。聊天 app 的拒绝作为错误结果交给模型，不算工具失败。
2. **系统提示一段。** 普通输出不会发到任何地方，发言必须调用发送工具，后面接上通知的说明：通知只是提示、可能已过时，什么时候读由 Agent 决定。这句话在插件的 `prompt` 里，不在每条通知里重复。
3. **通知的文字由 `renderNotice` 渲染。** 它是 `src/chat-plugin.ts` 里的一个普通函数，连接器用它的结果提交，requestId 是 `notice:<事件 ID>`，`steer`，并撤回 `notice:` 开头、还没交给模型的旧通知。

`chatPlugin` 从包里导出，因为聊天工具"崩溃后重做"的测试需要在真实 runtime 上注入故障存储适配器，而 `openAgentManager` 不暴露存储适配器。

## 连接器

### 职责

把聊天 app 的收件事件变成通知，交给 runtime。每个 Agent 一个，由 Manager 在打开 runtime 时挂上（`connectInbox`）。它只用 runtime 的 `cursor`、`advanceCursor` 和 `submit`。

### 一遍处理

1. 从上次处理到的事件 ID 往后读这个账号的收件事件。这个位置存在 runtime 的 Durable 文档里（游标名 `chat-inbox`）。
2. 有新事件时，向聊天 app 要当前的未读摘要，生成一条通知。每行带聊天工具接受的 timeline 参数，模型可以照抄去读。时间带日期和时区，因为模型没有别的时钟：

   ```
   截至 2026-01-01 14:32:05 UTC，至少有 7 条未读（其中 2 条 @ 了你），分布在 3 处，之后可能还有更多：
   #general {"conversation":1} 至少 4 条 · 最新发送者 @richard · @了你
   #general/讨论串 {"thread":42} 至少 2 条 · 最新发送者 @lin
   私信 @owner {"conversation":5} 至少 1 条 · 最新发送者 @owner
   每行花括号里就是 chat_read_unread 要的 timeline。
   ```

   工具名和通知文字都在聊天插件里。"通知只是提示、可能已过时"由聊天系统提示说一次，通知里不重复。摘要为空（这些消息都已读过）时不提交，只推进位置。
3. 用 `renderNotice(summary, at)` 的结果提交：`requestId = notice:<最新事件 ID>`、`steer`、`replaces = notice:`，撤回未交付的旧通知。Agent 正在运行时，通知插在当前这轮工具调用之后，收件箱里还没交给模型的旧通知先被撤回。哪些通知未交付由 Durable 的提交记录决定，所以任何时候最多一条未交付的通知。
4. 把位置推进到最新事件 ID。

打开时跑一遍，之后每收到一次这个账号的收件信号跑一遍。同一时间只跑一遍，跑的过程中来的信号只让它结束后再跑一遍。一遍出错只报告，位置不动，下一个信号重来。runtime 关闭前，Manager 先停掉连接器并等这一遍跑完。

第 3、4 步之间崩溃的话，重启后重新处理同一批事件，生成同一个 `requestId`。撤回不动与这次 `requestId` 相同的那条，Durable 去重，所以通知不会丢也不会重复，不需要跨库事务。
