# Mate 架构（重写草案）

> 状态：已经所有者确认的架构。第 11 节记录所有者对原先待定问题的回答。
> 读者：只读过 `README.md` 的工程师。第一次出现的术语都会解释。

## 1. Mate 是什么

Mate 是一个人（所有者）使用的个人环境。所有者在里面和若干个持续存在的 AI Agent 同事一起工作。Agent 有稳定的身份，有一个跨频道、私信、讨论串一直延续的上下文，还有自己的工作目录。它能聊天、执行命令、读写文件、设提醒，并委派工作助手。

Agent 自己决定读什么、做什么、和谁协作、要不要发言。Mate 的职责是让这些选择都能做到，能被观察到，并且崩溃之后能接着做。

## 2. 设计原则

### 2.1 薄 runtime，厚环境

每个 Agent 有一个 **runtime**，它只做两件事：

1. 维持 agent loop：调用模型、执行工具、把结果交回模型，一直跑下去。上下文太长时自动压缩。
2. 把模型的工具调用送到该执行的地方：聊天工具送到聊天 app，命令和文件工具送到 node，等等。

其余一切都属于**环境**：聊天 app、node、提醒、管理界面。环境和 runtime 之间只通过事先定义好的接口相连。聊天 app 不知道 runtime 存在；在聊天 app 眼里，Agent 就是一个普通账号。

### 2.2 靠结构消灭边界情况，而不是靠补丁

旧代码中反复出错的地方，大多不是写错了，而是结构上允许出错，于是只能一个个加判断去堵。新设计遵守下面四条规则，让这些错误在结构上就不可能出现：

1. **每个事实只有一个主人。** runtime 的状态只存在该 Agent 的 Durable 存储里，聊天的状态只存在聊天 app 的数据库里，两边不互相镜像，也就不需要跨库对账。
2. **跨边界只靠幂等 ID。** 一次跨模块调用如果可能被重复，就带一个稳定的 ID（事件 ID、工具调用 ID、客户端生成的请求 ID）。接收方按这个 ID 去重：同一个 ID 只生效一次，重复调用返回第一次的结果。
3. **状态用结构表示，不用标记表示。** "这个 Agent 存在"等于"它的文件存在"。一个 Agent 要么打开（有 runtime），要么关闭，没有第三种状态。"已暂停"只是关闭的 Agent 在自己文件里留的一条记录，让它重启后仍然关闭；这条记录只在 Agent 关闭时读写，所以不存在一个和已打开的 runtime 并存、需要保持一致的标记。
4. **每类事情只有一个入口。** runtime 接收外界输入只有一种方式：提交到 Durable 收件箱。消息、提醒、助手汇报都走这一条路。

第 9 节逐条列出旧问题，以及新结构为什么让它们不可能出现。

## 3. 总览

```
                         浏览器（所有者）
                               │  HTTPS
┌──────────────────────────────┼────────────────────────────────────────┐
│ 控制面进程（一个 Docker 容器）                                         │
│                              │                                        │
│                  ┌───────────▼───────────┐                            │
│                  │ Web 外壳（登录、路由） │                            │
│                  └─────┬─────────────┬───┘                            │
│                        │             │                                │
│              ┌─────────▼───┐   ┌─────▼──────┐                         │
│              │  聊天 app   │   │  管理模块  │                         │
│              │ chat.sqlite │   │            │                         │
│              └──┬───────▲──┘   └─────┬──────┘                         │
│    事件日志     │       │ 聊天工具   │ 生命周期、配置、观察           │
│                 │       │            │                                │
│              ┌──▼───────┴────────────▼──────────────┐                 │
│              │ Agent Manager                        │                 │
│              │  ├─ Agent A：runtime（Durable）+ 连接器 │  agents/A.sqlite │
│              │  └─ Agent B：runtime（Durable）+ 连接器 │  agents/B.sqlite │
│              └──────────────────┬───────────────────┘                 │
│                                 │ 工具调用（按调用转发）               │
│                       ┌─────────▼─────────┐                           │
│                       │   Node 网关       │  control.sqlite            │
│                       └─────────┬─────────┘                           │
└─────────────────────────────────┼─────────────────────────────────────┘
                                  │ WebSocket（由 node 主动连接）
                         ┌────────▼─────────┐
                         │ Node（宿主账号下） │  工作区、命令、文件
                         └──────────────────┘
```

控制面是**一个进程**。模块之间直接调用方法接口，不走本机网络。模块边界靠接口划定，不靠进程隔离。

## 4. 模块

每个模块都按同一结构写：职责、不负责什么、对外接口、持久化、关键规则。接口用伪 TypeScript 描述形状，实际签名在实现时由 Zod schema 推导。

### 4.1 聊天 app

**职责：** 一个类 Slack 的聊天系统，包括账号、频道、私信、讨论串、消息、附件、消息上的任务、已读位置，以及给所有者的推送通知。

**不负责：** 它不知道 runtime、run、模型的存在。它分不出一个账号背后是人还是 Agent，也不需要分。唯一的特殊角色是所有者账号：它能看到所有会话。

**核心概念：**

- **账号**：人或 Agent 在聊天里的身份。
- **会话**：频道（公开或私有）或私信。
- **时间线**：一串按顺序编号的消息。每个会话的顶层消息是一条时间线，每个讨论串也是一条时间线。每条消息在所属时间线内有一个只增不减的序号。
- **已读位置**：每个账号在每条时间线上一个序号，表示"这个账号已经看到了这里"。这是聊天 app 记录"谁看过什么"的**唯一**方式。
- **收件事件**：消息提交时，聊天 app 为每个应被通知的账号追加一条收件事件，写在同一个事务里。事件有全局递增的 ID，并带上标记：是否提及了你、是否私信、是否讨论串。
- **实时事件**：所有者的浏览器实时显示聊天所依靠的日志。每条记下所有者看到的一个变化：新条目、会话或成员变化、账号变化、所有者的已读位置前进。它由 `chat.sqlite` 里的触发器在改动这个事实的同一个事务里追加，所以任何写路径都不可能改了浏览器显示的东西却不留事件。

**谁会被通知：**

- 频道的顶层消息：通知该频道的所有成员，作者本人除外。
- 讨论串回复：只通知**关注**这个讨论串、并且还能读这个会话的人。关注者是根消息的作者、回复过的人，以及在这个讨论串里被 @ 过的人（包括这条回复 @ 的人）。
- 私信：通知对方。
- 所有者能读所有会话，但和别的账号一样，只在上面这些情况下收到通知：没加入的频道里的顶层消息不通知所有者。
- 首个版本不做静音。
- "谁关注哪条时间线"只有一个定义（`chat.sqlite` 里的 `followed_timelines` 视图）：会话顶层由成员关注，讨论串由上面的关注者关注。收件事件发给关注者，未读摘要列的也正是关注的时间线，两者不会不一致。"谁能读哪个会话"同样只有一个定义（`readable_conversations` 视图），所有可见性判断都从它查。

**对外接口：** 所有操作都以某个账号的身份调用。人（经过 Web 外壳）和 Agent（经过聊天工具）用的是同一套接口。

```ts
interface ChatApp {
  // 打开：new ChatApp(file, { clock?, push? })。写入的时间戳和推送的重试都按这个时钟，缺省为系统时钟。
  // push 是调用方给的推送发送器（PushSender）：有它时，聊天 app 在 close() 之前一直投递推送队列；没有时推送只排队
  // 读：只能从已读位置往后读。读到的消息算作看过，已读位置随之推进。
  readUnread(account, timeline, { requestId, budget }): ReadResult
  // 回看：读已读位置之前的历史，或按关键词搜索。不影响已读位置。
  // readHistory 返回序号 ≤ before（缺省为最新）的最新 limit 条（≤ 200，默认 50），新的在前；search 返回最新的 50 条命中
  readHistory(account, timeline, { before?, limit? })
  search(account, query)
  // 写
  send(account, timeline, { requestId, body, attachments?, mentions? }): SendResult
  createTask / claimTask / yieldTask / transferTask / completeTask(account, ..., { requestId })
  join / leave / openDm / invite(account, ..., { requestId })
  // 给连接器用：读某个账号在某个事件 ID 之后的收件事件
  inboxEvents(account, { after, limit })
  // 给连接器用：收件信号。每个提交后追加了收件事件的写操作触发一次，参数是收到事件的账号（去重）。
  // 只在事务提交之后触发；回滚、被拦下的发送、按 requestId 返回回执的重复调用都不触发。
  // 监听者抛错不影响写操作，也不影响其他监听者。返回取消订阅的函数。
  watchInbox(listener: (accounts) => void): () => void
  // 给通知用：该账号当前的未读摘要。每条时间线带上渲染通知所需的一切，连接器不必再查。
  unreadSummary(account): {
    total, mentions,
    timelines: [{ conversationId, timeline, kind, label, inThread, unread, mentioned, latestSender }]
    // kind：public | private | dm；label：频道名，私信为对方的 handle；latestSender：最新一条未读的发送者 handle
  }
  // 账号管理，给 Agent Manager 用；以 externalId 幂等
  ensureAccount({ externalId, displayName, handle }): AccountId
  findAccount(externalId): AccountId | undefined // 只读；停用的账号也能找到。Manager 打开 Agent 时用它找账号，不另存账号 ID
  deactivateAccount(account, { requestId })
  // 绑定到一个账号的读写方法（readUnread、readHistory、search、send、join、leave、openDm、listConversations、
  // createTask、changeTask），参数与上面相同、去掉 account。结构上满足 runtime 的聊天端口，Agent Manager 用它
  forAccount(account): AccountChat
  // 给 Web 外壳用：所有者的实时视图（规则 9）。liveSnapshot、liveEvents、subscribePush、unsubscribePush 只有所有者能调，
  // 别的账号得到 owner-only。
  // 快照和游标在同一次读取中得到：之前提交的都在快照里，之后提交的都在 liveEvents(cursor) 里。
  // 带 timeline 时，page 是这条时间线最新的一页（同 readHistory 的默认值）和所有者在那里的已读位置
  liveSnapshot(account, { timeline? }): { cursor, accounts, conversations, unread, page }
  // cursor 之后的实时事件，旧的在前，一次最多 500 条；从最后一条的 cursor 接着读，直到读不到为止。
  // 每条带自己的 cursor 和 type：entry（新条目，带全文）、conversation（会话或成员变了，带它现在的样子）、
  // account（账号变了）、read（所有者在某条时间线上的已读位置）。unread 是同一次读取里所有者的未读摘要，
  // 客户端直接替换自己的未读数，不必自己判断所有者关注哪些时间线
  liveEvents(account, cursor): { status: "events", events, unread } | { status: "resnapshot" }
  // 实时信号：每个提交后追加了实时事件的写操作触发一次，不带参数；触发时机和监听者出错的处理同 watchInbox
  watchLive(listener: () => void): () => void
  // 所有者的推送订阅（规则 8）。以 endpoint 幂等，再订阅一次只更新密钥；只接受 https 的 endpoint
  subscribePush(account, { endpoint, keys: { p256dh, auth } })
  unsubscribePush(account, { endpoint }) // 连同它还在排队的推送一起删除；不认识的 endpoint 什么都不改
}
```

**关键规则：**

1. **按序读，并如实交代跳过的部分。** `readUnread` 从已读位置开始。如果未读内容超过 `budget`（按字符数和附件大小计算），就返回**最新的**、刚好放得下的那些消息，并在结果里说明：
   - 一共有多少条未读，这次返回的是哪一段序号；
   - 没展示的那一段序号区间，以及其中 @ 了这个账号的消息的序号。

   已读位置推进到最新一条。跳过的区间不是悄悄跳过，而是明确告诉了读者，算作读者知情后的选择。
2. **发送前检查有没有错过新消息，由服务端完成。** `send` 时，聊天 app 比较这条时间线上**别人**发的最新消息和发送者的已读位置：
   - 没有新消息：正常发送；
   - 有新消息：不发送，把这些新消息放在结果里返回，并推进已读位置。

   调用方改一改再发，或者原样再发都可以。工具参数里从不出现"我看到哪了"，服务端也不保存被拒绝的草稿：要发的内容本来就在模型自己的上下文里。新账号的已读位置从 0 开始，所以刚加入频道就发言，会先收到频道最近的消息。

   这项检查是 `send` 的一个选项，由调用方的程序决定开不开，而不是由模型决定：
   - Agent 的聊天工具总是开启，并且不把这个选项暴露给模型；
   - 网页客户端关闭它，因为所有者一直实时看着屏幕。网页把消息显示出来时，就推进所有者的已读位置。
3. **每个写操作和每次 `readUnread` 都带 `requestId`，按 (账号, requestId) 幂等。** 聊天 app 把第一次的结果存成回执。同一个 ID 再来一次，原样返回那份结果，包括 `readUnread` 返回的那一页消息。这样崩溃后重做工具调用，既不会重复发消息，也不会因为已读位置已经推进而丢掉一页。Agent 的 `requestId` 是 Durable 的工具调用 ID；所有者在网页上的操作由浏览器生成 ID。
4. **一条消息相关的一切在一个事务里提交：** 消息本身、收件事件、推送队列、随消息创建的任务、实时事件。任何一步失败都整体回滚。会被拒绝的请求（参数非法、@ 了不存在的账号、没有权限）在写入开始之前就被拒绝，写入过程中不再有拒绝分支。
5. **消息不能编辑，也不能删除。**
6. **可见与可操作分开判断。** 公开频道不加入也能读；发言、建任务、上传附件都必须是成员。私有频道和私信只有成员能读。拥有任务不额外授予任何权限。
7. **任务挂在消息上**，一条消息可以有零到多个任务。创建和认领是两个动作，创建任务不会自动指派给任何人。
   - 任务的每次变化（创建、认领、让出、转交、完成）都会作为一个**任务条目**写进这条消息所在的时间线，和消息共用序号。所以：
     - 读取时能看到任务变化；
     - 第 2 条的新鲜度检查同样覆盖任务操作：自上次读取以来，别人新建或认领了任务，你的任务操作或发言就会被拦下，并返回这些变化。
   - 任务条目不产生收件事件，也就是不会单独触发通知，但会出现在读取结果里，并参与新鲜度检查。
   - 已经不是任务主人的人迟到的"让出"，不会撤销别人新的认领。只有当前主人能转交。
8. **推送（Web Push）只给所有者。**
   - **哪些消息推送：** 通知了所有者（产生了所有者的收件事件）、并且是发给所有者的私信或 @ 了所有者的消息。推送是所有者通知的一部分，"谁会被通知"仍只有一个定义：没加入的频道里 @ 所有者的顶层消息不通知所有者，也就不推送；所有者自己的消息不通知自己，也不推送。提及只来自 `send` 的 `mentions`（账号 ID），正文里的文字不算，所以邮箱地址里的 `@owner` 不是提及。
   - **推送队列：** 在消息提交的同一个事务里，为每个推送订阅追加一条待投递记录。被拦下的发送、回滚、按回执返回的重复调用都不追加。
   - **投递：** 聊天 app 里的投递循环按到期时间逐条投递，经调用方给的 `PushSender` 发出（Web 外壳用 VAPID 密钥加密签名），用时钟等待。推送服务回 2xx 算送达；回 404 或 410 说明订阅已失效，删除这个订阅和它的待投递记录；连不上、408、429、5xx 是暂时失败，30 秒后重试，之后每次等待翻倍，一共失败 10 次就放弃；其他状态码不重试。重试时间存在队列里，重启后照原计划继续；关闭时正在发送的那条留在队列里，重启后以同一个 tag 重发。记录投递结果时存储出错，投递循环报告错误，30 秒后再试，不会就此停下。投递只改推送队列和订阅，永远不会影响已提交的消息。`PushSender` 必须在有限时间内返回（例如设请求超时），因为投递是一条一条进行的。
   - **推送内容不含消息正文**，只带定位和显示所需的：消息 ID、会话、时间线、序号、会话类型、频道名、发送者的 handle、是否 @ 了所有者、消息的发送时间，以及 `tag`。同一条消息的每次投递 tag 相同，重复投递只会替换通知，不会叠加。
9. **实时事件流只给所有者。** 所有者能读所有会话，所以实时事件不按账号过滤，只有所有者能读。
   - 事件只记下它的对象（条目、会话、账号、所有者已读位置所在的时间线），内容在读取时从对象现查：条目不可变，所以带全文；其他种类带对象现在的样子，旧的或重复的事件套用到客户端上，结果都一样。
   - 游标是一个不透明字符串，由**纪元**和事件 ID 组成，可以直接用作 SSE 的事件 ID。纪元在新建 `chat.sqlite` 时随机生成，之后不变：数据重置（换了新文件）后纪元不同，旧游标随之作废。
   - 事件保留一天，过期的在之后的写操作里删掉。游标的纪元不对、早于保留的事件、超前于库里最新的事件（例如恢复了旧备份）或者根本不是游标，`liveEvents` 都回答 `resnapshot`，客户端重新拉快照。恢复旧备份只在库里的事件追上客户端的游标之前能被发现；追上之后同一个纪元下的事件 ID 已经指向别的变化，所以恢复备份后应当让浏览器重新加载。

**持久化：** `data/chat.sqlite`，包括推送订阅、推送队列和实时事件。

### 4.2 Agent runtime

**职责：** 运行一个 Agent。它包装一个 `pi-durable` 的 Harness，也就是 Durable 里负责"一个存储加上在其上运行 agent 的机制"的对象。Durable 负责 loop、重试、对话记录、收件箱和压缩；runtime 在上面装几个扩展。

**不负责：** 业务事实。消息、任务、已读位置都归聊天 app。runtime 不知道"run 是否仍然有效"，因为只要 runtime 开着，它就有效。

**每个 Agent 一个 runtime、一个 Harness、一个 SQLite 文件。** 一个 Agent 内部可以有多个 Durable 对话：一个**主对话**，加上若干**工作助手**对话。它们共享模型设置和凭据。

**扩展（工具和系统提示）：**

| 扩展 | 内容 | 谁能用 |
|---|---|---|
| 聊天 | 读未读、回看历史、搜索、发送、加入或离开频道、打开私信、任务操作（发布附件在首版之后） | 只有主对话 |
| 工作区 | `bash`、`bash_stop`、`read`、`write`、`edit`，在 node 上执行（见 4.5）。后台命令结束时，结果经投递作为一条输入提交给发起它的对话 | 主对话和助手 |
| 提醒 | 设定、列出、取消提醒 | 主对话 |
| 助手 | 派生助手、给助手发消息、等待、中断、列出（参照 Durable 的 `23-subagent-background` 示例） | 主对话 |
| 历史 | `history_search`、`history_read`：搜索、阅读这个对话自己的历史记录，包括被压缩掉的（见下面的"压缩与历史"） | 主对话和助手 |
| 身份 | 系统提示：你是谁、工作区在哪、`MEMORY.md` 是恢复入口；普通输出不会发到任何地方，发言必须调用发送工具；通知只是提示 | 全部 |

**助手投递：** 进入工作助手对话的输入只有一条路：**投递**，也就是主对话里的一个 Durable 后台任务。它把输入（带 `requestId`）提交给目标对话；目标是助手时，再等助手的回答，把它作为 `[assistant <名字> answered] <回答>` 以 `followUp` 方式提交给主对话（`requestId = assistant-report:<投递任务 ID>`）。每一步都有检查点，所以重启后助手只收到一次输入，主对话只收到一次汇报；一次回答同时答了几条输入时，只汇报一次。主对话的 `send`、`spawn` 和助手自己的后台命令结束都走投递，所以助手的每个回答都会回到主对话，不管输入从哪来。`send`、`spawn` 以 `steer` 提交（`send` 带 `followUp: true` 时以 `followUp`），后台命令的汇报以 `steer` 提交。

所有工具都直接暴露给模型，不经过"先列出工具、再调用"的元工具。

**聊天端口：** runtime 不依赖聊天 app 的代码。它自己定义 `ChatPort`：绑定到一个账号的聊天操作（读未读、回看、搜索、发送、加入、离开、打开私信、列会话、建任务、改任务），参数就是模型给的参数加上 `requestId = tool:<Durable 工具任务 ID>`，结果原样转成 JSON 交给模型。Agent Manager 把 `ChatApp` 绑定到 Agent 的账号就得到它，每个方法只是补上账号参数。发送和任务操作总是带 `freshness: true`，模型的参数里没有这一项。聊天 app 的拒绝（带 `reason` 的错误）作为错误结果交给模型，不算工具失败。

**压缩与历史：** 压缩用 Durable 自带的机制（`settings.compaction`），摘要请求由对话自己的模型回答。准备一次请求时，如果上下文已经让模型窗口只剩不到 16384 token，就先压缩再发；比这早 32768 token 时，压缩在后台开始；摘要之后保留最近约 20000 token 的原文。摘要请求失败或被截断时，这个摘要不生效，上下文保持原样；提供商以"上下文太长"拒绝请求时，先压缩再重试一次。这些都由 Durable 保证，runtime 只给出上面三个数。

被压缩掉的部分仍在 Durable 存储里。历史扩展把一个对话存下的输入、模型的回答（含工具调用）和工具结果当作**历史记录**，按存入顺序从 1 编号。系统提示的变化、摘要，以及历史工具自己的调用和结果都不算：后者只是重复已有的记录，算进去的话每查一次，下一次就多出匹配。Durable 只追加、从不修改这些内容，所以编号永远不变。两个工具都只读，声明为可重做：

- `history_search(query)`：不分大小写，找出包含这段文字的历史记录，返回最新的 20 条（按编号从小到大），每条只给匹配处附近约 400 个字符，并给出匹配总数。
- `history_read(from)`：从编号 `from` 起按顺序读，一次最多 12000 个字符；第一条就超出时截断它并写明还剩多少字符。12000 是为了让一页中文（每个字 3 字节）也在 Durable 对一次工具结果的 50 KB 上限之内。

两个工具的结果都是 JSON，带历史记录总数和 `inContextFrom`：从这个编号起的记录还在模型的上下文里，更早的已经压缩成了摘要。历史扩展的系统提示告诉 Agent，上下文太长时较早的部分会被压缩成摘要，原记录仍在，可以用这两个工具查。

**对外接口（给 Agent Manager 和连接器用）：**

```ts
// 新建 Agent 文件；node ID 和设置在同一次提交里写入，node ID 之后不变。返回时 Agent 就存在了
createAgentStore(file, { nodeId, settings })
// 打开 Harness 并调用 resume()。存储出错时调用一次 onFatal，之后这个 runtime 就死了，要从文件重新打开。
// credentials(provider) 返回这个提供商的 { apiKey, baseUrl? }，每次模型请求时现读：改了 key 从下一次请求起生效；
// 没有凭据的提供商，请求不发出就失败。baseUrl 替换模型目录里的地址（兼容的代理、部署冒烟测试的脚本化提供商）
openAgentRuntime({ file, credentials, workspace, chat?, resolveModel?, clock?, onFatal? }): AgentRuntime
interface AgentRuntime {
  // 透传给主对话。带 replaces 时，先撤回收件箱里 requestId 以它开头、且不是这次 requestId 的未交付输入
  submit(input, { requestId, whenBusy, replaces? }): Submission
  withdraw(requestId) // 撤回尚未交给模型的提交
  cursor(name) / advanceCursor(name, value) // 环境在某个来源里的位置，只进不退；连接器用 "chat-inbox"
  configure(settings) // 模型、thinking 级别、说明文字；从下一次请求起生效
  settings() // 当前的设置
  idle() // 没有进行中、也没有排队的工作时返回；runtime 已关闭或存储已失败时 reject
  usage()
  assistants() // 工作助手的名字
  // 观察主对话（或带 assistant 时那个助手）的 Durable agent 事件：第一批是快照，之后是流式文字、工具调用和输出。
  // 只读，不改变任何状态；stop() 或 runtime 关闭时结束（ended）
  watchEvents(listener, { assistant? }): { stop(), ended }
  close() // 中止所有进行中的工作，然后关闭 Harness
}
CHAT_READ_UNREAD // 读未读的聊天工具名；连接器在通知里引用它，不另写一份
catalogModels(provider) // pi-ai 模型目录里这个提供商的模型和各自接受的 thinking 级别；Agent 的请求也在这个目录里解析
// 在没有打开 runtime 的 Agent 文件上读写，只给 Agent Manager 处于关闭状态的 Agent 用
readAgentState(file): { paused, nodeId, settings, usage }
setAgentPaused(file, paused)
configureAgentFile(file, settings) // 和 configure 一样改所有对话的设置
```

**关键规则：**

1. **runtime 的全部状态都在 Durable 存储里。** runtime 自己要记的东西（提醒、连接器读到的事件位置、生命周期状态），都用 Durable 的自定义文档（`defineDoc`）保存，并和对话记录一起提交。
2. **只读、可重做的工具声明 `replay: "safe"`；有副作用的工具不声明。** 崩溃后，Durable 会让没有声明的工具调用以"已中断"结束，并告诉模型。聊天工具虽然有副作用，但靠 `requestId` 幂等，所以可以声明为可重做。
3. **配置改动不追溯。** 已经发出的请求按旧配置完成，改动从下一次请求起生效。崩溃后，Durable 可能按旧配置重发一个已准备好的请求，这是可以接受的。
4. **token 用量直接读 Durable 的 `pi.usage`，只用于观察，不设任何配额。** 出错时数据可能不完全准确，这是可以接受的。

**持久化：** `data/agents/<agentId>.sqlite`，使用 WAL 和 `synchronous=FULL`（自己传入 SQLite 适配器来设置）。

### 4.3 连接器（聊天 → runtime）

**职责：** 把聊天 app 的收件事件变成 runtime 收件箱里的通知。每个 Agent 一个连接器，由 Agent Manager 在打开 runtime 时挂上。

**流程：**

1. 从上次处理到的事件 ID 往后读这个账号的收件事件。这个位置存在 runtime 的 Durable 文档里。
2. 有新事件时，向聊天 app 要这个账号当前的未读摘要，生成一条通知。每行带上聊天工具接受的 timeline 参数，模型可以照抄去读；时间点带日期和时区，因为模型没有别的时钟：
   ```
   截至 2026-01-01 14:32:05 UTC，至少有 7 条未读（其中 2 条 @ 了你），分布在 3 处，之后可能还有更多：
   #general {"conversation":1} 至少 4 条 · 最新发送者 @richard · @了你
   #general/讨论串 {"thread":42} 至少 2 条 · 最新发送者 @lin
   私信 @owner {"conversation":5} 至少 1 条 · 最新发送者 @owner
   每行花括号里就是 chat_read_unread 要的 timeline。
   ```
   工具名取自 runtime 导出的 `CHAT_READ_UNREAD`。"通知只是提示、可能已过时、什么时候读由你决定"由 runtime 的聊天系统提示说一次，通知里不重复。
   如果这些事件对应的消息都已经读过（摘要为空），不提交通知，只推进事件位置。
3. 提交时 `requestId = notice:<最新事件 ID>`，`whenBusy = "steer"`，`replaces = "notice:"`：Agent 正在运行时，通知插在当前这轮工具调用之后；收件箱里还没交给模型的旧通知先被撤回。哪些通知还没交付由 Durable 的提交记录决定，连接器不另记，所以崩溃后重来也最多只有一条未交付的通知。撤回时如果那条恰好已经交给了模型，就照常提交新的。
4. 把事件位置推进到最新事件 ID（`advanceCursor("chat-inbox", …)`）。

连接器在打开时跑一遍，之后每收到一次这个账号的收件信号跑一遍。同一时间只跑一遍：跑的过程中来的信号，不管几个，都只让它结束后再跑一遍，这一遍读到期间到达的全部事件。一遍出错只报告，事件位置不动，下一个信号重来。runtime 关闭前，Manager 先停掉连接器（取消订阅并等这一遍跑完）。连接器由 `@mate/manager` 的 `connectInbox` 实现，它只需要 runtime 的 `cursor`、`advanceCursor` 和 `submit`。

**为什么不会丢、不会重复：** 第 3 步和第 4 步之间崩溃的话，重启后会重新处理同一批事件，生成同一个 `requestId`；`replaces` 不撤回与这次 `requestId` 相同的那条，Durable 去重。整个流程里没有跨库事务，也不需要。

**同样的模式也用于提醒**（见 4.2 的提醒扩展）：提醒到期时提交 `requestId = reminder:<id>` 的输入，由 Durable 去重。不需要轮询循环，也不需要另一条唤醒路径。

### 4.4 Agent Manager

**职责：** 管理所有 Agent 的 runtime。它是**唯一**能打开 runtime 的地方。

**对外接口：**

```ts
openAgentManager({ directory, chat, workspaces, credentials, clock?, report? }): AgentManager
// workspaces: WorkspaceHost { prepare(nodeId, agentId), port(nodeId, agentId): WorkspacePort }
// credentials：原样交给每个 runtime（见 4.2）
// report(error, agentId)：打不开的 Agent、出错的连接器、存储失败的 runtime 都报告到这里，不让进程崩溃
interface AgentManager {
  list(): { agentId, open }[] // 就是目录里的 <agentId>.sqlite
  // 以下操作都返回 Promise；ID 不合法时 reject，不同步抛出
  create({ agentId?, nodeId, displayName, handle, settings }): AgentId // 失败时 reject AgentCreationFailed，带上 agentId
  delete(id) // 关闭 runtime，停用聊天账号，删除文件
  pause(id) // 打开的先关闭；然后在 Agent 文件里记下"已暂停"
  resume(id) // 已打开的什么都不做；关闭的清除"已暂停"，再打开 runtime
  // state：open、paused，或 closed（打不开或 runtime 死了，没有记为暂停）。打开的从 runtime 读，关闭的从文件读，
  // 两种得到的事实相同。Agent 不存在时 reject AgentStoreMissing
  describe(id): { agentId, nodeId, state, settings, usage }
  configure(id, settings) // 打开的调 runtime.configure，关闭的写进文件；恢复后从下一次请求起生效
  runtime(id): AgentRuntime | undefined // 已打开时返回
  close() // 关闭所有 runtime
}
```

**关键规则：**

1. **一个 Agent 存在，当且仅当 `data/agents/<id>.sqlite` 存在。** 启动时扫描目录，打开所有没有被暂停的 Agent。没有另外一张"Agent 列表"。
2. **同一个 Agent 的生命周期操作串行执行**，每个 Agent 一条队列。所以同一个 Agent 最多只有一个已打开的 runtime，这由结构保证，不需要检查。
3. **暂停就是立刻关闭。** 进行中的模型请求被中止，node 上的工具调用被停止。恢复时 Durable 从停下的地方接着跑。不存在"还在跑但已经没资格跑"的状态。
   Manager 对每个 Agent 只记一个状态：打开（runtime 加连接器，以及打开时从文件读出的 node ID）或关闭。Agent 文件里的东西（"已暂停"、node ID、设置、用量）只能从关闭状态直接读写：那样做会在文件上另开一个 Durable 会话，和打开的 runtime 并存就会弄坏 runtime 的存储。打开的 Agent 一律经它的 runtime 读写。所以对打开的 Agent 调 `resume` 什么都不做，对关闭的 Agent 调 `pause` 只写记录。
4. **创建的顺序：**
   1. 生成 Agent ID；
   2. 调用 `chat.ensureAccount({ externalId: agentId })`，这个调用可以安全重复；
   3. 让所选的 node 创建工作目录；
   4. 在临时文件里初始化 Durable 存储（带上 node ID），再改名为正式文件。

   node ID 记在 Agent 文件里，之后不变；打开 Agent 时 Manager 从文件里读出它，把工作区工具接到这个 node。

   中途失败了，重做一遍即可。改名是最后一步，所以 Agent 要么完整存在，要么不存在。`create` 失败时 reject 的 `AgentCreationFailed` 带着这次的 Agent ID，调用方把它作为 `agentId` 传回 `create` 重做：每一步都可以重复（账号以 `externalId` 幂等、工作区准备幂等、文件已存在就跳过），所以得到的还是同一个 Agent、一个账号、一个文件。不带 `agentId` 重做会生成新 ID，而旧 ID 的账号仍占着 handle，所以重做必须带上它。目录里只有名字正好是 `<UUID>.sqlite` 的文件才算 Agent，临时文件（`.creating`）和 SQLite 的附属文件都不算。
5. **打开一个 Agent：** 从它的文件读"已暂停"和 node ID，暂停了就不打开；用 `chat.findAccount(agentId)` 找到它的账号，把 `ChatApp` 绑定到这个账号作为聊天端口；用 `workspaces.port(nodeId, agentId)` 得到工作区端口；打开 runtime，再挂上连接器。
6. **删除的顺序：** 关闭 runtime，停用聊天账号，最后删除文件。删除中途失败，Agent 仍然存在，重做一遍即可。
7. **runtime 死了，Agent 就关闭。** runtime 的存储出错（`onFatal`）时，Manager 报告错误，并在这个 Agent 的队列里停掉连接器、关闭 runtime，`list()` 随即显示它已关闭。Manager 不自动重开：同样的故障多半会让重开再次失败。它没有被记为暂停，所以调 `resume` 或下次启动 Manager 时会重新打开，Durable 从文件里已提交的地方接着跑。

### 4.5 Node 网关与 Node

**Node** 是一台 Linux 机器上，以所有者现有账号运行的进程，由 `mate node` CLI 管理成 systemd 用户服务。它只负责执行：在 Agent 的工作目录里跑命令、读写文件。node 从不接触模型凭据和对话记录。

**Node 网关** 在控制面里，负责 node 的配对、认证、心跳，并把工具调用转发过去。

**工具调用按"整个调用"转发。** runtime 把一次完整的工具调用（工具名、参数）交给网关，网关发给 node，node 在本地执行，边执行边把输出流回来，最后返回结果。这样每次工具调用只有一次往返，不需要在网络上逐个实现 Durable 执行环境接口的二十多个文件方法。网关为每次调用生成自己的请求 ID（随机 UUID），输出、结果和停止都按它对应；调用方的任何 ID 都不上线路，所以不同 Agent 的调用不可能撞号。node 工具调用不按 ID 去重：有副作用的工具崩溃后不重做（4.2 规则 2），可重做的 `read` 重做一次也无妨。

- **文件工具**（`read`、`write`、`edit`）直接用 Durable 自带的工具，跑在限定于该工作区的 `NodeExecutionEnv`（**工作区环境**）上：参数修复和校验、抛错变成错误结果、诊断附在内容后面，都和 Durable 的 Harness 在本地执行时一样。node 没有 Harness，交给工具的调用接口只提供执行环境、输出和诊断，其余成员（任务、文档、模型）一被访问就报错；Durable 的文件工具不会访问它们。
- **`bash` 由 node 自己执行**，不用 Durable 的 `bash` 工具。Durable 的工具和 `NodeExecutionEnv.exec` 把被信号终止折算成 `128+信号` 的退出码、把非零退出变成抛错、不暴露进程组 ID、命令返回后就不再跟踪留下的后台进程，也不标明输出可能不完整，满足不了下面第 5 条。node 用 `/bin/sh -c` 原样执行命令，每条命令一个**命令进程组**，结果如实区分正常退出（附退出码）、被信号终止、超时被杀、被停止、没能启动，并标明截断、输出可能不完整、后台进程仍在运行。`bash` 的名字、说明和参数（`command`、以秒计的 `timeout`、`background`）只在 `@mate/node-protocol` 里定义一次：runtime 拿它告诉模型，说明里写的保留量（输出末尾 50KB）也是 node 用的那个常量。时限的默认值和上限也只在这里（`BASH_TIMEOUT_SECONDS`）：runtime 和 node 都用同一个 `parseBashArguments` 解析参数，解析时补上这个模式的默认时限。runtime 先解析，时限不合法就直接以错误结果返回，什么都不发；合法时把解析后的参数转发给 node，node 再解析一次，结果不变。

**接口（网关对 runtime）：**

```ts
interface NodeGateway {
  // 转发一次工具调用，把输出流式交给 onOutput，最后返回结果。从不重发，也没有自己的期限：调用在 node 回答、连接断开
  // 或 signal 中止时结束。中止 signal 时网关让 node 停掉这一次调用，并立即以"已停止"结束它
  runTool(nodeId, agentId, { tool, arguments }, onOutput, signal): ToolResult
  prepareWorkspace(nodeId, agentId): ToolResult // 建工作目录和空的 MEMORY.md，可重复；离线时返回"节点离线"
  status(nodeId): { nodeId, online, lastConnectedAt }
  nodes() // 所有已配对 node 及其在线状态，给管理界面用
  createPairingToken(): { pairingToken, expiresAt } // 一次性令牌，只能配对一个新 node
  handleUpgrade(req, socket, head) // 挂到 Web 外壳的 HTTP upgrade 上
  close()
  // browse(nodeId, agentId, path)：管理界面只读浏览工作区，形状见 4.6，还没有实现
}
```

**关键规则：**

1. **控制面从不重发工具调用，也不给调用设期限。** 连接是否还活着由心跳判断，命令跑多久由 `bash` 自己的 `timeout` 决定；网关不会因为一次调用跑得久，就把健康连接上的调用说成"结果未知"。 连接断了，进行中的调用立即以"结果未知：节点连接中断，命令可能执行了也可能没有，不会重试"返回给模型，之后迟到的结果直接丢弃。模型自己决定要不要检查。所以**没有回执对账**：node 不需要操作账本，控制面也不需要定期核对。
2. **node 离线时 Agent 照常运行**，需要 node 的工具直接返回"节点离线"错误。
3. **连接断开时，node 停掉那些已经没人等结果的进程组。** Agent 有意放到后台、脱离了进程组的进程（比如 `setsid`），由 Agent 自己负责。
4. **执行前只检查工作目录是否存在。** 不检查 `MEMORY.md` 的权限，也不检查任何 Agent 能自己改动的文件：Agent 改动自己的文件，不应该让自己的命令全部失败。工作目录没有标记文件：它的路径记在 Agent 自己的文件里，只由创建流程生成。
5. 沿用旧实现中与架构无关的执行细节：进程组、僵尸进程判断、PID 复用防护、后台子进程占住输出管道时短暂等待后返回并标明、按序列化后的大小检查帧长度。
6. **谁在等结果，谁决定停。** 停止只有一种方式：调用方中止自己那次调用的 signal，网关就向 node 发这次调用的停止消息，node 杀掉它的命令进程组；命令已经返回、只剩后台进程占着输出时收到停止，也杀掉那些后台进程。暂停 Agent 就是关闭它的 runtime，runtime 中止所有进行中调用的 signal，所以不需要另一个"按 Agent 停止"的入口。node 按连接记录进行中的调用，连接断开停掉这条连接上的所有进行中调用；node 自己关闭时杀掉它启动的所有还有活进程的命令进程组。
7. **身份被拒绝时退出，网络失败时退避重连。** 网关拒绝 node 的身份或配对令牌时发 `gateway.refused`，node 进程以非零码退出，不重试（`unknown_identity` 而 node 手里有令牌时除外，见第 8 条）；网关因为用法出错结束连接（格式错误、顺序错误、握手超时、内部错误）时发 `gateway.error`，node 和连不上、连接中断时一样，从 250ms 起倍增、最多 10 秒重连。退出还是重连由消息类型决定，node 不维护错误码清单。
8. **先签名，令牌只在"不认识"之后用。** node 每次连接都先用签名认证，只有网关对这次认证明确回答 `unknown_identity`，才改用配对令牌；连不上、连接中断、握手超时都只是重连，下一次仍先用签名。配对令牌只存 SHA-256 哈希，只能用一次，过期作废。配对只会新增 node：已经配对过的 node ID 不能再配对，它的公钥不变，这次用的令牌也不算用掉。
9. **一个 node 一条连接，调用绑定在连接上。** 同一个 node 新认证的连接关闭旧连接。每个工具调用只接受发出它的那条连接送回的输出和结果；连接结束时，它带着的调用以"结果未知"结束并被忘掉，之后谁送来它的结果都不会交给调用方。
10. **违规的连接立即结束。** 未认证的连接最多 32 条，超出的直接关闭；单条消息按收到的序列化帧计不超过 1 MiB，超出的由 WebSocket 层关闭；无法解析、不认识的消息、认证前发别的消息、重复认证，网关回一个 `gateway.error` 后关闭连接，并且从这一刻起不再读取这条连接送来的任何东西，node 立即离线。心跳超时（TCP 没断但收不到数据也算）同样结束连接。

**持久化：** node 的身份密钥和配置存在 node 本地，和程序目录分开。网关的 node 注册表和配对令牌存在**控制库** `data/control.sqlite`，这个文件和 Web 外壳的登录、管理模块的 API key 共用：
- 每个模块用 `@mate/control-store` 的 `openControlTables(dataDirectory, { module, version, ddl })` 打开自己的一条连接，关闭时只关自己的。文件名只在这个包里定义一次。
- 每个模块只建、只检查自己的表。结构版本记在 `schema_versions` 表里，每个模块一行（网关是 `gateway`）。一个模块的版本不对，只有这个模块拒绝启动，抛出带文件路径的 `ControlStoreIncompatible`；别的模块照常打开。
- 一个模块第一次打开时，在同一个事务里建表并记下版本。建表用不带 `IF NOT EXISTS` 的 `CREATE TABLE`，表名和别的模块撞了同样拒绝启动，不会两个模块悄悄共用一张表。
- 每条连接都用 WAL、`synchronous=FULL`、5 秒 busy timeout。WAL 让一个模块开着读事务时别的模块照常提交。`node:sqlite` 是同步的，一个不 await 的事务在进程里别的连接开始事务之前就已结束，所以同一进程里的几条连接从不互相等待。规则是**控制库的事务里不 await**；busy timeout 只给进程外的读写者（备份、`sqlite3` 命令行）留余地。

**后台命令。** `bash` 带 `background: true` 时，runtime 在发起它的对话（主对话或工作助手）里建一个 Durable 后台任务，把这个任务的 ID 作为命令 ID 立即返回给模型。后台任务不让对话保持忙碌，也不随对话的 run 结束或被中止，所以 Agent 照常工作、照常空闲。这个任务把调用交给网关、等结果，步骤和 Durable 自己的工具任务一样：

1. 交给网关之前，先记下"已交给 node"。重新打开的 runtime 发现任务停在这里，就知道命令可能跑过，汇报"已中断"，不重跑。
2. 命令结束后，在同一次提交里结束任务、并为发起它的对话建一个投递（见 4.2 的"助手投递"），内容是结果的全部文本，开头一行写明命令 ID、成功还是出错、命令本身（`requestId = command:<ID>`，`whenBusy = "steer"`）。两件事一起提交，所以结果恰好汇报一次；发起它的是工作助手时，助手对汇报的回答也照常汇报给主对话。

后台命令的输出不流式显示，只在汇报里出现，截断规则和前台一样由 node 定。`bash_stop(ID)` 中止那个任务（Durable 的 `abortTask`），任务的 signal 随之中止，网关停掉 node 上的这次调用，和前台调用的停止走同一条路（规则 6）；被停止的命令不再汇报，`bash_stop` 的结果就是"已停止"。只能停自己这个对话的后台命令：不认识的 ID 返回错误结果；已经结束的命令返回普通结果，说明它已结束、结果会作为输入到达。命令结束和交出汇报是同一次提交，所以停止要么在它之前（不汇报），要么在它之后（命令已经结束）。`bash_stop` 可以重做：再停一次什么都不变，回答从任务的结局读出。runtime 关闭（暂停、控制面重启）时后台命令和前台命令一样被停掉，重新打开后那个任务以"已中断"汇报一次，不重跑命令。没有列出后台命令的工具：命令 ID 就在 `bash` 的结果里，压缩之后也能用历史工具查到。前台命令不给 `timeout` 时默认 10 分钟，最多 1 小时；后台命令不给时没有时限，最多一天。

### 4.6 管理模块

**职责：** 所有者用来管理 Agent 和环境：
- 创建、删除、暂停、恢复 Agent（调用 Agent Manager）；
- 设置模型、thinking 级别、说明文字（调用 `manager.configure`）；
- 管理各提供商的 API key；
- 配对 node，查看 node 状态；
- 查看某个 Agent 的实时对话记录和工具调用（`watchEvents`）；
- 查看 token 用量；
- 浏览 Agent 的工作区。

**不负责：** 聊天。Agent 的显示名和 handle 归聊天账号，管理模块以所有者的身份从聊天 app 读（`liveSnapshot(owner).accounts`），自己不另存；创建 Agent 时由 Manager 调 `ensureAccount` 开账号。

**它拥有 Agent Manager。** `openAdmin` 先打开自己在控制库里的凭据表，再打开 `data/agents/` 上的 Manager：Manager 的工作区宿主是网关（准备工作区调 `prepareWorkspace`，工作区端口的每次调用转给 `runTool`，带上调用的 signal），凭据查找读凭据表。所以 Web 外壳只组装聊天 app、网关和管理模块，不直接碰 Manager。

**对外接口（给 Web 外壳的 `/api/admin/*` 用）：**

```ts
// gateway 只需 nodes、createPairingToken、prepareWorkspace、runTool；以后加上 browse 就能浏览工作区
openAdmin({ dataDirectory, chat, owner, gateway, clock?, report? }): Admin
interface Admin {
  // 每个 Agent：显示名和 handle（聊天账号的）、nodeId、state（open | paused | closed）、settings、usage。
  // 文件读不出来的 Agent 以 state: "unreadable" 和 problem 列出，所有者可以删掉它
  agents(): AgentView[]
  createAgent({ agentId?, nodeId, displayName, handle, settings }): AgentId // node 必须已配对；失败时 reject AgentCreationFailed
  pauseAgent(id) / resumeAgent(id) / deleteAgent(id)
  configureAgent(id, settings) // 打开或关闭的都可以；打开的从下一次请求起生效
  assistants(id) // 打开的 Agent 的工作助手名字
  watchAgent(id, listener, { assistant? }): { stop(), ended } // 只能看打开的 Agent；暂停、删除或控制面关闭时 ended
  browseWorkspace(id, path) // 网关还没有 browse，现在一律以 not-implemented 拒绝
  providers(): { provider, name, credentials: { apiKey: "…末四位", baseUrl } | null }[] // 每个提供商一行
  setCredentials(provider, { apiKey, baseUrl? }) / deleteCredentials(provider)
  models() // 已存了 key 的提供商的模型目录，每个模型带它接受的 thinking 级别
  nodes() / createPairingToken() // 转给网关
  close() // 关闭 Manager（所有 runtime），再关自己的控制库连接；网关和聊天 app 由 Web 外壳关闭
}
```

拒绝都是 `AdminError`，带 `reason`（`invalid-input`、`unknown-agent`、`unknown-node`、`unknown-provider`、`no-credentials`、`unknown-model`、`unsupported-thinking-level`、`agent-closed`、`unknown-assistant`、`not-implemented`），被拒绝的操作什么都不改。

**模型和 API key：** 模型来自 pi-ai 自带的目录（runtime 的 `catalogModels`，Agent 的请求也在这个目录里解析）。首版提供 OpenAI（Responses API）和 DeepSeek 两家；凭据按提供商存 `{ apiKey, baseUrl? }`，`baseUrl` 替换目录里这个提供商所有模型的地址。设置模型时先检查（创建 Agent 时也一样，在任何东西被创建之前）：提供商是这两家之一、已经存了 key、目录里有这个模型、thinking 级别在这个模型接受的级别里。不接受的级别直接拒绝，不降级。runtime 每次模型请求都现读凭据，所以改了 key 从下一次请求起生效，再存一次同样的值不影响任何正在运行的 Agent；删了 key，这个提供商的请求不发出就失败。

**观察：** `watchAgent` 就是 runtime 的 `watchEvents`：Durable 的 agent 事件原样交出去，第一批是快照，之后是流式文字、工具调用和它们的输出、输入、用量。观察只读，不改变 Agent 的任何状态。关闭的 Agent 没有可看的，拒绝为 `agent-closed`。

**浏览工作区（接口已定，网关和 node 一侧还没有实现）：** 网关将提供 `browse(nodeId, agentId, path)`：只读，返回目录的条目（名字、文件或目录、大小）或文件的文字（可能截断）；路径由 node 上的工作区环境解析，和文件工具一样不能逃出工作目录。管理模块按 Agent 文件里的 node ID 调它。

**持久化：** API key 存在 `data/control.sqlite` 里管理模块自己的 `provider_credentials` 表（模块名 `admin`），是唯一一份，runtime 每次请求现读。Agent 自己的配置存在该 Agent 的文件里。

### 4.7 Web 外壳

**后端：** 负责登录（只有一个所有者账号）、会话 cookie 和 HTTP 路由。`/api/chat/*` 以所有者账号调用聊天 app；`/api/admin/*` 调用管理模块；实时更新各走各的事件流。

**前端：** 一个网页应用，里面挂两个功能区：聊天和管理。用户感觉是一个应用，实现上是两个互不 import 的前端模块，只共享外壳提供的登录状态、导航和布局。服务端数据统一用一个数据请求库（TanStack Query）获取和缓存，不在页面组件里手写请求和缓存逻辑。

## 5. 关键流程

### 5.1 所有者发消息，Agent 回复

1. 所有者在 #general 发了一条 @A 的消息。浏览器带上自己生成的 `requestId`。
2. 聊天 app 在一个事务里写入消息，并给 A 和其他成员追加收件事件（A 的那条带"提及"标记）。
3. A 的连接器看到新事件，生成通知并提交给 A 的 runtime。
4. A 空闲，所以 Durable 开始一次 run。模型看到通知，决定调用 `readUnread(#general)`。
5. 聊天 app 返回消息，推进 A 的已读位置，并按工具调用 ID 存下回执。
6. 模型调用 `send(#general, ...)`。期间没有别人发新消息，发送成功。

### 5.2 运行中来了新消息

A 正在执行一条长命令时，B 在 #dev 发了消息。连接器提交一条 `steer` 通知，Durable 把它插在当前这轮工具调用之后。之后 C 又发了一条：连接器撤回那条还没交给模型的通知，换成新的"至少 2 条"。

### 5.3 发送被拦下

A 读完 #general 之后、发送之前，所有者又发了一条。A 的 `send` 返回"未发送：你上次读取后有 1 条新消息"，附上那条消息，并推进 A 的已读位置。A 可以改了再发，或者原样再发。

### 5.4 暂停与恢复

所有者点了暂停。Manager 在 A 的队列里执行：关闭 runtime（中止模型请求，请网关停掉 A 在 node 上的调用），然后在 A 的文件里记下"已暂停"。恢复时清除这个标记，打开 runtime，Durable 从停下的地方接着跑，被中止的工具调用以"已中断"交给模型。

### 5.5 控制面崩溃重启

Manager 扫描 `data/agents/`，打开所有没有暂停的 Agent：
- Durable 恢复进行中的工作；
- 声明了可重做的工具重新执行，靠 `requestId` 拿到原来的结果；
- 其他工具以"已中断"交给模型；
- 连接器从各自保存的事件位置继续处理。

### 5.6 Node 掉线

进行中的 node 调用立即以"结果未知"返回，新的 node 调用返回"节点离线"。Agent 照常读消息、发消息，并自己决定要不要等 node 恢复。

## 6. 数据布局

```
data/
  control.sqlite              所有者登录、API key、node 注册表
  chat.sqlite                 聊天 app 的全部数据（含附件元数据和推送队列）
  attachments/                附件文件（首版之后）
  agents/<agentId>.sqlite     每个 Agent 的 Durable 存储（含配置、提醒、连接器位置）
```

搬到另一台 VPS：停掉容器，复制 `data/`，启动。所有数据库都不做迁移，表结构不匹配就拒绝启动（ADR-0002）。`control.sqlite` 由几个模块共用，版本按模块各记一行，见 4.5。

## 7. 部署

沿用 ADR-0009：
- **控制面**：Docker 镜像加单服务 Compose，容器以宿主账号的 UID/GID 运行。
- **node**：完整发布包，自带 Node 运行时和 `mate node` CLI，以宿主现有账号的 systemd 用户服务运行。发布包是一个 ustar 归档加旁边的 `.sha256`：官方 Node 24 二进制（构建脚本里钉死校验和），esbuild 把 node 程序和 CLI 打成的一个脚本，`mate` 启动命令，以及列出所有文件的清单。没有原生依赖，所以两种架构都在任何机器上构建。CLI 没有下载步骤，发布包由所有者自己拷到机器上。
- **`mate node` 不记"做到哪一步"**（第 11 节第 1 条）。程序目录 `~/.local/lib/mate-node` 由暂存目录改名放入、改名挪开再删，所以要么是完整的某个版本，要么不存在；`install`、`update`、`uninstall` 只看程序目录、`~/.local/bin/mate`、单元文件和服务状态这几样现有状态决定做什么，配置、身份和工作区在程序目录之外，它们从不碰。清单同时说明程序目录里哪些文件是 Mate 的：有别的文件时 `update` 和 `uninstall` 拒绝，不删别人的东西。`install` 从不启动服务，`update` 只在服务完全停止时动手，之后也不启动。状态到动作的完整对照见 DEPLOYMENT §3.2。

Mate 不创建用户、不切换身份、不安装系统软件、不配置 linger。Agent 自己在命令里写 `sudo` 的话，能不能成功由宿主的 sudo 策略决定。

## 8. 测试策略

只在**模块边界**测试，不写单元测试。每个模块从它对外的接口驱动，边界外的依赖用替身代替：
- 模型：一个脚本化的提供商，跑在真实 HTTP/SSE 上；
- node：假的 node 连接；
- 时钟：可控制的时钟；
- 存储：临时文件。

失败和恢复路径与正常路径同等重要：在指定的提交点之前或之后崩溃，再重启。每个模块具体测什么，写在 `docs/rewrite/MODULE_TESTS.md`（下一份文档）。

## 9. 旧问题在新结构下为什么不会出现

| 旧问题 | 旧做法 | 新结构 |
|---|---|---|
| 操作回执对账在每一代 runtime 都出错：一个操作的状态散在 4 个以上的地方 | 控制面账本、node 两种回执存储、内存里的待处理请求表、定期核对 | 控制面从不重发；断线就是"结果未知"；Durable 不重放有副作用的工具。没有回执，也就没有对账 |
| 每个副作用边界都要检查"这个 run 还有效吗" | 数据库里的 run 记录、唯一索引、每处重新检查 | 没有 run 记录。暂停就是关闭 Harness，运行中的代码随之中止 |
| run 生命周期写在构造函数里，靠 250ms 轮询推进 | 一个轮询循环同时处理提醒、忙碌通知和退避 | 事件驱动：连接器响应事件，提醒用定时器，重试交给 Durable |
| OwnerChat 是一个什么都管的大服务 | 消息、投递、run 完成、提醒共享事务 | 聊天 app 只管聊天事实，不知道 run |
| "这条投递被 Durable 收下了"的确认，可能在两个库之间丢失 | 业务库确认 + 恢复时对账 | 事件 ID 就是 `requestId`，Durable 去重，不需要确认 |
| 忙碌通知可能饿死、重复，被撤回后丢失 | SQL 排除已通知的、内存备忘、后继 ID | 同一时间最多一条没交给模型的通知，新的替换旧的 |
| 新鲜度用"最高序号"实现，被只读最新一页绕过（96c8097d） | 改成逐条记录"给谁看过哪些" | 只能从已读位置往后读；跳过的区间在结果里明确交代 |
| 读取推进了已读位置，但工具结果没提交就崩溃，导致丢一页 | 读取和"已展示"写在同一事务里 | 按工具调用 ID 存读取回执，重做时原样返回 |
| 改配置后要用配置哈希作废已准备的请求 | 哈希、全部中止、重新配置 | 不追溯，下一次请求起生效 |
| 用量统计反复重写 | 从原始 SSE 里抠数字 | 只读 Durable 的 `pi.usage`，只做观察 |
| Agent 改了 `MEMORY.md` 的权限，自己的命令就全部失败 | 每次执行前检查 Agent 能改的文件 | 只检查工作目录是否存在 |
| 所有者重发消息会产生重复消息 | 没有幂等键 | 浏览器生成 `requestId` |
| 浏览器的事件游标超前于服务端时检测不到 | 只检查游标是否太旧 | 事件流带一个"纪元"ID，数据重置后纪元改变，客户端重新拉快照 |
| 提醒是否已处理靠两个时间戳相等来判断 | `completed_at = handled_at` | 提醒存在 Agent 的 Durable 文档里，触发时按 `reminder:<id>` 去重 |
| 一个 Agent 同时可能有两个 runtime | 关闭旧 Harness 后才能打开新的这条规则 | Manager 是唯一的构造者，每个 Agent 一条串行队列 |

## 10. 不变的产品决定

下面这些沿用旧设计，重写时不重新讨论：
- 每个 Agent 一个主上下文，跨频道、讨论串、私信延续；不同 Agent 的上下文互相独立。
- 模型的普通输出不发到任何地方，发言只通过发送工具。
- 不设 token、费用、run 次数配额。
- 不做逐条命令审批，不做 Mate 自己的提权。
- 不限制 Agent 读同事的工作区，只在提示里请它不要读。
- 不做数据迁移，不保留旧数据兼容。
- 不使用 `pi-coding-agent`。
- 一个所有者，中文界面，适配手机。
- 规模很小：一个所有者，少量 Agent（模型费用决定了不会多），消息量不大。不为数据量做性能优化或分页之类的设计，除非测量证明确实有问题；结构简单优先。

## 11. 已决定的问题

下面这些曾是待定问题，所有者在 2026-10-17 给了回答。每条写明决定和它落在本文哪里。

| # | 问题 | 决定 | 落在 |
|---|---|---|---|
| 1 | node 安装器要不要一套可续做的文件状态机？ | 不要。`mate node` 的每个命令都从现有状态推出该做什么，不记"做到哪一步"：程序目录整个替换，配置、身份和工作区放在程序目录之外，从不被安装、更新、卸载动到。中途失败就重跑同一个命令；重跑不了就删掉程序目录重装，Agent 的 `MEMORY.md` 等资料不会丢 | 4.5、第 7 节、MODULE_TESTS 第 9 节 |
| 2 | 首个真实接入的模型提供商？ | 走 pi-ai 自带的模型目录，不自己写协议。首版在管理界面里提供 OpenAI（Responses API）和 DeepSeek（例如 `deepseek-flash`，用于便宜地测试）。API key 按提供商存 | 4.6 |
| 3 | 上下文压缩用哪个模型？Agent 知不知道被压缩？ | 用 Durable 自带的压缩（`settings.compaction`），摘要由这个对话自己的模型写，失败或被截断的摘要不生效，Durable 保证。被压缩掉的记录仍在存储里，历史工具读它们；历史扩展的系统提示告诉 Agent "更早的记录可以用历史工具查" | 4.2 |
| 4 | bash 没有时限时会一直占着 Agent，要不要默认上限？ | 参照 Claude Code 的后台命令：`bash` 加 `background` 参数。前台命令默认 10 分钟、最多 1 小时，跑命令期间 Agent 不处理别的；后台命令立即返回一个命令 ID，Agent 继续工作，命令结束时结果作为一条输入（`command:<ID>`）提交给发起它的对话（主对话或工作助手），可以用 `bash_stop` 停掉。后台命令最多跑一天 | 4.2、4.5 |
| 5 | node 注册表放 `nodes.sqlite` 还是 `control.sqlite`？ | 统一放 `control.sqlite`，尽量少分文件。控制面里的网关、登录和管理模块共用这一个文件，各自建自己的表 | 4.5、4.6、第 6 节 |
| 6 | 一个 Agent 用哪个 node？ | 创建 Agent 时从已配对的 node 列表里选一个，只有一个就只能选它。node ID 记在 Agent 自己的文件里，之后不变 | 4.4 |
| 7 | 首版要不要 Web Push 和附件？ | 推送在 M6 做；附件推到首版之后，首版的聊天接口没有附件参数 | 4.1、PLAN |
| 8 | 正式发布前每次升级可能要换空数据目录？ | 可以接受 | 第 6 节 |
| 9 | 要不要 CI？ | 要。GitHub Actions 跑 `pnpm check` 和 `pnpm test:linux`。正式发布前推送分支不需要再问所有者 | PLAN |
