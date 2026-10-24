# Mate 架构

> 读者：只读过 `README.md` 的工程师。第一次出现的术语都会解释。

## 1. Mate 是什么

Mate 是几个人共用的小环境：每个人是一个人类账号，角色是管理员或普通人类。他们在里面和若干个持续存在的 AI Agent 同事一起工作。Agent 有稳定的身份，有一个跨频道、私信、讨论串一直延续的上下文，还有自己的工作目录。它能聊天、执行命令、读写文件、设提醒，并委派工作助手。

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
                         浏览器（人类）
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

**包。** 模块边界用 pnpm 包来强制：每个包只通过 `package.json` 的 `exports` 暴露公开接口，从外部 import 包的内部文件会直接构建失败。

| 包 | 内容 |
|---|---|
| `packages/chat`（`@mate/chat`） | 聊天 app |
| `packages/runtime`（`@mate/runtime`） | Agent runtime 及其扩展 |
| `packages/manager`（`@mate/manager`） | Agent Manager 和连接器 |
| `packages/node-protocol`（`@mate/node-protocol`） | 网关与 node 之间的消息格式，包括工具名和工具结果的形状 |
| `packages/clock`（`@mate/clock`） | 时钟：`now` 和可中止的 `sleep`，各模块共用，测试里换成可控时钟 |
| `packages/gateway`（`@mate/gateway`） | node 网关 |
| `packages/migrations`（`@mate/migrations`） | 迁移：一个存储的结构就是一串按版本递增的迁移（`Migrations`），聊天库和控制库都用它建表和升级 |
| `packages/control-store`（`@mate/control-store`） | 控制库：几个模块共用 `control.sqlite` 时，各自打开自己的表并按模块迁移结构版本 |
| `packages/admin`（`@mate/admin`） | 管理模块：Agent 的生命周期和设置、提供商的 API key、模型目录、node 配对、观察 Agent；它打开 Agent Manager，并把 node 网关接成工作区宿主 |
| `packages/testkit`（`@mate/testkit`） | 测试替身和工具，只给测试用 |
| `apps/control-plane`（`@mate/control-plane`） | Web 外壳后端和组装入口：登录、HTTP 路由、事件流、推送发送器、前端静态文件，`main.ts` 从环境变量启动 |
| `apps/web`（`@mate/web`） | 前端 |
| `apps/node`（`@mate/node`） | node 进程和 `mate node` CLI |
| `tests/system`（`@mate/system-tests`） | 起真实控制面和 node 进程的系统场景（MODULE_TESTS 第 12 节） |

## 4. 模块

每个模块都按同一结构写：职责、不负责什么、对外接口、持久化、关键规则。接口用伪 TypeScript 描述形状，实际签名由 Zod schema 推导。

### 4.1 聊天 app

**职责：** 一个类 Slack 的聊天系统，包括账号、频道、私信、讨论串、消息、附件、消息上的任务、已读位置，以及给人类账号的推送通知。

**不负责：** 它不知道 runtime、run、模型的存在。账号分两种，**人类**和 **Agent**，创建时定下、之后不变。人类账号能看到所有会话，也只有人类账号有实时视图和推送；可以有多个人类账号，各有各的已读位置、未读摘要和推送订阅。聊天 app 不管谁登录、谁是管理员，那是 Web 外壳的事。

**核心概念：**

- **账号**：人或 Agent 在聊天里的身份，种类（`kind`）是 `human` 或 `agent`。
- **会话**：频道（公开或私有）或私信。
- **时间线**：一串按顺序编号的消息。每个会话的顶层消息是一条时间线，每个讨论串也是一条时间线。每条消息在所属时间线内有一个只增不减的序号。
- **已读位置**：每个账号在每条时间线上一个序号，表示"这个账号已经看到了这里"。这是聊天 app 记录"谁看过什么"的**唯一**方式。
- **收件事件**：消息提交时，聊天 app 为每个应被通知的账号追加一条收件事件，写在同一个事务里。事件有全局递增的 ID，并带上标记：是否提及了你、是否私信、是否讨论串。
- **实时事件**：人类账号的浏览器实时显示聊天所依靠的日志，全局一条。每条记下一个变化：新条目、会话或成员变化、账号变化、某个人类账号的已读位置前进，并带受众（`audience`）：空表示每个人类账号都看到，否则只有那个账号看到（已读位置属于前进的那个人类账号）。它由 `chat.sqlite` 里的触发器在改动这个事实的同一个事务里追加，所以任何写路径都不可能改了浏览器显示的东西却不留事件。

**谁会被通知：**

- 频道的顶层消息：通知该频道的所有成员，作者本人除外。
- 讨论串回复：只通知**关注**这个讨论串、并且还能读这个会话的人。关注者是根消息的作者、回复过的人，以及在这个讨论串里被 @ 过的人（包括这条回复 @ 的人）。
- 私信：通知对方。
- 人类账号能读所有会话，但和别的账号一样，只在上面这些情况下收到通知：没加入的频道里的顶层消息不通知人类账号。
- 不做静音。
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
  // kind：human | agent，必填，在账号创建时定下；对已有账号换一个 kind 为 invalid-input。名字和 handle 不合法为 invalid-input；
  // handle 被别的账号占着为 handle-taken；已停用的账号（Agent 被删除）为 inactive-account，停用是永久的，它的 externalId 不能再用
  ensureAccount({ externalId, displayName, handle, kind }): AccountId
  listAccounts(): AccountView[] // 只读；每个账号（停用的也列出）的 accountId、handle、displayName、kind、active
  findAccount(externalId): AccountId | undefined // 只读；停用的账号也能找到。Manager 打开 Agent 时用它找账号，不另存账号 ID
  findHuman(handle): { accountId, externalId, active } | undefined // 只读；handle 不分大小写，只找人类账号（Agent 的 handle 找不到），停用的也找到。Web 外壳的登录用它从 handle 找到人类
  deactivateAccount(account, { requestId })
  // 绑定到一个账号的读写方法（readUnread、readHistory、search、send、join、leave、openDm、listConversations、
  // createTask、changeTask），参数与上面相同、去掉 account。结构上满足 runtime 的聊天端口，Agent Manager 用它
  forAccount(account): AccountChat
  // 给 Web 外壳用：人类账号的实时视图（规则 9）。liveSnapshot、liveEvents、subscribePush、unsubscribePush 只有人类账号能调，
  // Agent 账号得到 human-only。
  // 快照和游标在同一次读取中得到：之前提交的都在快照里，之后提交的都在 liveEvents(cursor) 里。
  // 带 timeline 时，page 是这条时间线最新的一页（同 readHistory 的默认值）和调用者在那里的已读位置；me 是调用者自己的账号 ID，客户端不必猜自己是谁
  liveSnapshot(account, { timeline? }): { cursor, me, accounts, conversations, unread, page }
  // cursor 之后的实时事件，旧的在前，一次最多 500 条；从最后一条的 cursor 接着读，直到读不到为止。
  // 每条带自己的 cursor 和 type：entry（新条目，带全文）、conversation（会话或成员变了，带它现在的样子）、
  // account（账号变了）、read（调用者在某条时间线上的已读位置）。只返回受众为空或为调用者的事件，
  // cursor 仍是全局位置：返回的 cursor 越过了不属于调用者的事件，所以事件稀少的人类账号也会往前走。
  // unread 是同一次读取里调用者的未读摘要，客户端直接替换自己的未读数，不必自己判断关注哪些时间线
  liveEvents(account, cursor): { status: "events", events, cursor, unread } | { status: "resnapshot" }
  // 实时信号：每个提交后追加了实时事件的写操作触发一次，不带参数；触发时机和监听者出错的处理同 watchInbox
  watchLive(listener: () => void): () => void
  // 人类账号的推送订阅（规则 8），记在订阅它的账号名下。以 endpoint 幂等，再订阅一次更新密钥，由另一个人类账号再订阅则归到那个账号，并丢掉原账号在这个订阅上还在排队的推送；只接受 https 的 endpoint
  subscribePush(account, { endpoint, keys: { p256dh, auth } })
  unsubscribePush(account, { endpoint }) // 删除这个账号自己的订阅，连同它还在排队的推送；不认识的、或别的账号订阅的 endpoint 什么都不改，回答相同
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
   - 网页客户端关闭它，因为人类一直实时看着屏幕。网页把消息显示出来时，就推进这个人类的已读位置。
3. **每个写操作和每次 `readUnread` 都带 `requestId`，按 (账号, requestId) 幂等。** 聊天 app 把第一次的结果存成回执。同一个 ID 再来一次，原样返回那份结果，包括 `readUnread` 返回的那一页消息。这样崩溃后重做工具调用，既不会重复发消息，也不会因为已读位置已经推进而丢掉一页。Agent 的 `requestId` 是 Durable 的工具调用 ID；人类在网页上的操作由浏览器生成 ID。
4. **一条消息相关的一切在一个事务里提交：** 消息本身、收件事件、推送队列、随消息创建的任务、实时事件。任何一步失败都整体回滚。会被拒绝的请求（参数非法、@ 了不存在的账号、没有权限）在写入开始之前就被拒绝，写入过程中不再有拒绝分支。
5. **消息不能编辑，也不能删除。**
6. **可见与可操作分开判断。** 公开频道不加入也能读；发言、建任务、上传附件都必须是成员。私有频道和私信只有成员能读。拥有任务不额外授予任何权限。
7. **任务挂在消息上**，一条消息可以有零到多个任务。创建和认领是两个动作，创建任务不会自动指派给任何人。
   - 任务的每次变化（创建、认领、让出、转交、完成）都会作为一个**任务条目**写进这条消息所在的时间线，和消息共用序号。所以：
     - 读取时能看到任务变化；
     - 第 2 条的新鲜度检查同样覆盖任务操作：自上次读取以来，别人新建或认领了任务，你的任务操作或发言就会被拦下，并返回这些变化。
   - 任务条目不产生收件事件，也就是不会单独触发通知，但会出现在读取结果里，并参与新鲜度检查。
   - 已经不是任务主人的人迟到的"让出"，不会撤销别人新的认领。只有当前主人能转交。
8. **推送（Web Push）只给人类账号，每个订阅只推它自己账号的通知。**
   - **哪些消息推送：** 对一个订阅，通知了它的账号（产生了该账号的收件事件）、并且是发给该账号的私信或 @ 了该账号的消息，而且该账号仍然有效（已停用的账号的订阅什么也收不到：入队时不排，已经排着的也在发送前再查一次，停用了就丢弃）。推送是通知的一部分，"谁会被通知"仍只有一个定义：没加入的频道里 @ 某个人类账号的顶层消息不通知它，也就不推送；自己的消息不通知自己，也不推送；发给 A 的私信只推 A 的订阅，不推 B 的。提及只来自 `send` 的 `mentions`（账号 ID），正文里的文字不算，所以邮箱地址里的 `@owner` 不是提及。
   - **推送队列：** 在消息提交的同一个事务里，为每个推送订阅追加一条待投递记录。被拦下的发送、回滚、按回执返回的重复调用都不追加。
   - **投递：** 聊天 app 里的投递循环按到期时间逐条投递，经调用方给的 `PushSender` 发出（Web 外壳用 VAPID 密钥加密签名），用时钟等待。推送服务回 2xx 算送达；回 404 或 410 说明订阅已失效，删除这个订阅和它的待投递记录；连不上、408、429、5xx 是暂时失败，30 秒后重试，之后每次等待翻倍，一共失败 10 次就放弃；其他状态码不重试。重试时间存在队列里，重启后照原计划继续；关闭时正在发送的那条留在队列里，重启后以同一个 tag 重发。记录投递结果时存储出错，投递循环报告错误，30 秒后再试，不会就此停下。投递只改推送队列和订阅，永远不会影响已提交的消息。`PushSender` 必须在有限时间内返回（例如设请求超时），因为投递是一条一条进行的。
   - **推送内容不含消息正文**，只带定位和显示所需的：消息 ID、会话、时间线、序号、会话类型、频道名、发送者的 handle、是否 @ 了这个订阅的账号、消息的发送时间，以及 `tag`。同一条消息的每次投递 tag 相同，重复投递只会替换通知，不会叠加。
9. **实时事件流只给人类账号。** 人类账号能读所有会话，所以除已读位置外的事件不按账号过滤；已读位置属于前进的那个人类账号，只出现在它自己的事件里（受众）。读取时按受众过滤，游标不过滤：它仍是全局位置。
   - 事件只记下它的对象（条目、会话、账号、已读位置所在的时间线），内容在读取时从对象现查：条目不可变，所以带全文；其他种类带对象现在的样子，旧的或重复的事件套用到客户端上，结果都一样。
   - 游标是一个不透明字符串，由**纪元**和事件 ID 组成，可以直接用作 SSE 的事件 ID。纪元在新建 `chat.sqlite` 时随机生成，之后不变：数据重置（换了新文件）后纪元不同，旧游标随之作废。
   - 事件保留一天，过期的在之后的写操作里删掉。游标的纪元不对、早于保留的事件、超前于库里最新的事件（例如恢复了旧备份）或者根本不是游标，`liveEvents` 都回答 `resnapshot`，客户端重新拉快照。恢复旧备份只在库里的事件追上客户端的游标之前能被发现；追上之后同一个纪元下的事件 ID 已经指向别的变化，所以恢复备份后应当让浏览器重新加载。

**持久化：** `data/chat.sqlite`，包括推送订阅（带订阅它的账号）、推送队列和实时事件（带受众）。

### 4.2 Agent runtime

**职责：** 运行一个 Agent。它包装一个 `pi-durable` 的 Harness，也就是 Durable 里负责"一个存储加上在其上运行 agent 的机制"的对象。Durable 负责 loop、重试、对话记录、收件箱和压缩；runtime 在上面装几个扩展。

**不负责：** 业务事实。消息、任务、已读位置都归聊天 app。runtime 不知道"run 是否仍然有效"，因为只要 runtime 开着，它就有效。

**每个 Agent 一个 runtime、一个 Harness、一个 SQLite 文件。** 一个 Agent 内部可以有多个 Durable 对话：一个**主对话**，加上若干**工作助手**对话。它们共享模型设置和凭据。

**扩展（工具和系统提示）：**

| 扩展 | 内容 | 谁能用 |
|---|---|---|
| 聊天 | 读未读、回看历史、搜索、发送、加入或离开频道、打开私信、任务操作（还不能发布附件） | 只有主对话 |
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
- `history_read(from)`：从编号 `from` 起按顺序读，一页按序列化后的 JSON 的 UTF-8 字节数计，最多 40000 字节（含 JSON 外壳和转义）；第一条就超出时截断它并写明还剩多少字符。40000 是为了让一页无论是中文、转义很多的文本还是几百条很短的记录，都在 Durable 对一次工具结果的 50 KB（51200 字节）上限之内，不会被截成无效的 JSON。`history_search` 的结果用同一个预算，放不下时丢掉最旧的匹配。

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
  // 只读，不改变任何状态；stop()、runtime 关闭或 runtime 因存储故障而死亡时结束（ended）
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
  create({ agentId?, nodeId, displayName, handle, settings }): AgentId // 文件改名之前失败时 reject AgentCreationFailed，带上 agentId；ID 已是某个存在的 Agent 时 reject AgentIdInUse
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
   2. 调用 `chat.ensureAccount({ externalId: agentId })`，这个调用可以安全重复。聊天 app 的拒绝（`handle-taken`、`invalid-input`，已删除 Agent 的 ID 为 `inactive-account`）原样 reject，不包成 `AgentCreationFailed`：这一步被拒绝时什么都还没创建，没有可重做的东西；
   3. 让所选的 node 创建工作目录；
   4. 在临时文件里初始化 Durable 存储（带上 node ID），再改名为正式文件。

   node ID 记在 Agent 文件里，之后不变；打开 Agent 时 Manager 从文件里读出它，把工作区工具接到这个 node。

   **已存在的 ID 不能再创建。** `create` 带着文件已存在（或已打开）的 Agent 的 ID，以 `AgentIdInUse` 拒绝，什么都不改（名字、暂停状态都不动）；已删除的 Agent 的账号已停用，`ensureAccount` 拒绝。改名之后 Agent 已经存在：随后 runtime 打不开时，Manager 报告错误、`create` 照常返回，Agent 处于关闭状态（和启动时打不开一样），`resume` 再打开它，所以重做只对改名之前的失败有意义。

   中途失败了，重做一遍即可。改名是最后一步，所以 Agent 要么完整存在，要么不存在。步骤 3、4 失败时 reject 的 `AgentCreationFailed` 带着这次的 Agent ID，调用方把它作为 `agentId` 传回 `create` 重做：每一步都可以重复（账号以 `externalId` 幂等、工作区准备幂等），所以得到的还是同一个 Agent、一个账号、一个文件。不带 `agentId` 重做会生成新 ID，而旧 ID 的账号仍占着 handle，所以重做必须带上它。目录里只有名字正好是 `<UUID>.sqlite` 的文件才算 Agent，临时文件（`.creating`）和 SQLite 的附属文件都不算。
5. **打开一个 Agent：** 从它的文件读"已暂停"和 node ID，暂停了就不打开；用 `chat.findAccount(agentId)` 找到它的账号，把 `ChatApp` 绑定到这个账号作为聊天端口；用 `workspaces.port(nodeId, agentId)` 得到工作区端口；打开 runtime，再挂上连接器。
6. **删除的顺序：** 关闭 runtime，停用聊天账号，最后删除文件。删除中途失败，Agent 仍然存在，重做一遍即可。
7. **runtime 死了，Agent 就关闭。** runtime 的存储出错（`onFatal`）时，Manager 报告错误，并在这个 Agent 的队列里停掉连接器、关闭 runtime，`list()` 随即显示它已关闭。Manager 不自动重开：同样的故障多半会让重开再次失败。它没有被记为暂停，所以调 `resume` 或下次启动 Manager 时会重新打开，Durable 从文件里已提交的地方接着跑。

### 4.5 Node 网关与 Node

**Node** 是一台 Linux、macOS 或 Windows 机器上，以宿主现有账号运行的进程，由 `mate node` CLI 管理。Linux 用 systemd 用户服务，macOS 用 LaunchAgent，Windows 用当前账号登录时启动的计划任务。它只负责执行：在 Agent 的工作目录里跑命令、读写文件。node 从不接触模型凭据和对话记录。

**Node 网关** 在控制面里，负责 node 的配对、认证、心跳，并把工具调用转发过去。

**node 的名字和系统信息。** UUID 只做身份，配对、签名认证、工具调用和 Agent 文件都继续使用它。**node 名字**是管理员可改的人读名字，在全部已配对 node 中唯一。名字有 1 到 32 个小写字母、数字或 `-`，以字母或数字开头。**系统信息**是 node 每次握手现取的一份完整报告，包含 `platform`、`arch`、`hostname`、`osRelease`、`version`，五项都是字符串。前四项来自 `process.platform`、`process.arch`、`os.hostname()`、`os.release()`；`version` 是构建发布包时写入程序的发布版本，源码运行时为 `dev`。

新 node 的 `node.authenticate`、`node.pair` 都必须带 `system`。网关容忍旧 node 缺少这个字段；带了字段就必须是完整报告。新配对的名字取 hostname，转成小写、把非法字符逐个换成 `-`、去掉开头的 `-`、截到 32 位。结果为空或旧 node 没有报告时，用 `node-<UUID 前 8 位>`。名字冲突时依次加 `-2`、`-3`，先为后缀留出长度。配对时，令牌消耗、身份、名字、系统报告和连接时间在同一个事务提交。认证时一起更新系统报告、报告时间和连接时间，之后才登记在线连接；旧握手只更新连接时间，不清空已有报告。改名只改名字，之后的握手保留它；网关的拒绝用 `GatewayError` 表示，不改变已存事实。

**工具调用按"整个调用"转发。** runtime 把一次完整的工具调用（工具名、参数）交给网关，网关发给 node，node 在本地执行，边执行边把输出流回来，最后返回结果。这样每次工具调用只有一次往返，不需要在网络上逐个实现 Durable 执行环境接口的二十多个文件方法。网关为每次调用生成自己的请求 ID（随机 UUID），输出、结果和停止都按它对应；调用方的任何 ID 都不上线路，所以不同 Agent 的调用不可能撞号。node 工具调用不按 ID 去重：有副作用的工具崩溃后不重做（4.2 规则 2），可重做的 `read` 重做一次也无妨。

- **文件工具**（`read`、`write`、`edit`）直接用 Durable 自带的工具，跑在限定于该工作区的 `NodeExecutionEnv`（**工作区环境**）上：参数修复和校验、抛错变成错误结果、诊断附在内容后面，都和 Durable 的 Harness 在本地执行时一样。node 没有 Harness，交给工具的调用接口只提供执行环境、输出和诊断，其余成员（任务、文档、模型）一被访问就报错；Durable 的文件工具不会访问它们。
- **`bash` 由 node 自己执行**，不用 Durable 的 `bash` 工具。Durable 的工具和 `NodeExecutionEnv.exec` 把被信号终止折算成 `128+信号` 的退出码、把非零退出变成抛错、不暴露进程组 ID、命令返回后就不再跟踪留下的后台进程，也不标明输出可能不完整，满足不了下面第 5 条。node 用所在系统的 shell 执行命令：Linux 和 macOS 是 `/bin/sh -c`，Windows 是 `powershell.exe -NoProfile -NonInteractive -Command`（PowerShell 5.1）。每条命令一个**命令进程组**，结果如实区分正常退出（附 shell 的退出码）、被信号终止（POSIX）、超时被杀、被停止、没能启动，并标明截断、输出可能不完整，以及 POSIX 后台进程仍在运行。PowerShell 保留原生程序的非零退出码。`bash` 的名字、说明和参数（`command`、以秒计的 `timeout`、`background`）只在 `@mate/node-protocol` 里定义一次：runtime 拿它告诉模型，说明里写的保留量（输出末尾 50KB）也是 node 用的那个常量。时限的默认值和上限也只在这里（`BASH_TIMEOUT_SECONDS`）：runtime 和 node 都用同一个 `parseBashArguments` 解析参数，解析时补上这个模式的默认时限。runtime 先解析，时限不合法就直接以错误结果返回，什么都不发；合法时把解析后的参数转发给 node，node 再解析一次，结果不变。

**接口（网关对 runtime）：**

```ts
interface NodeGateway {
  // 转发一次工具调用，把输出流式交给 onOutput，最后返回结果。从不重发，也没有自己的期限：调用在 node 回答、连接断开
  // 或 signal 中止时结束。中止 signal 时网关让 node 停掉这一次调用，并立即以"已停止"结束它
  runTool(nodeId, agentId, { tool, arguments }, onOutput, signal): ToolResult
  prepareWorkspace(nodeId, agentId): ToolResult // 建工作目录和空的 MEMORY.md，可重复；离线时返回"节点离线"
  status(nodeId): NodeStatusResult // 不存在的 node 以 unknown-node 拒绝
  nodes(): NodeStatusResult[] // 所有已配对 node，给管理界面用
  renameNode(nodeId, name) // 名字不合法为 invalid-input，被其他 node 占用为 name-taken，不存在为 unknown-node；原名不变
  createPairingToken(): { pairingToken, expiresAt } // 一次性令牌，只能配对一个新 node
  handleUpgrade(req, socket, head) // 挂到 Web 外壳的 HTTP upgrade 上
  close()
  // 只读地看工作区里的一个路径，给管理界面用，见下面的"浏览工作区"。离线或回答之前连接断开时立即回答 node-offline
  browse(nodeId, agentId, path): { ok: true, listing } | { ok: false, reason, message }
}

type NodeStatusResult = {
  nodeId: string
  name: string
  online: boolean
  lastConnectedAt: string | null
  system: NodeSystem | null // 最近一次完整报告，从未报告时为 null
}
```

**关键规则：**

1. **控制面从不重发工具调用，也不给调用设期限。** 连接是否还活着由心跳判断，命令跑多久由 `bash` 自己的 `timeout` 决定；网关不会因为一次调用跑得久，就把健康连接上的调用说成"结果未知"。 连接断了，进行中的调用立即以"结果未知：节点连接中断，命令可能执行了也可能没有，不会重试"返回给模型，之后迟到的结果直接丢弃。模型自己决定要不要检查。所以**没有回执对账**：node 不需要操作账本，控制面也不需要定期核对。
2. **node 离线时 Agent 照常运行**，需要 node 的工具直接返回"节点离线"错误。
3. **连接断开时，node 停掉那些已经没人等结果的命令进程组。** 各平台能追踪的范围见第 5 条；Agent 有意放到后台、脱离了这个范围的进程（比如 POSIX 上的 `setsid`），由 Agent 自己负责。
4. **执行前只检查工作目录是否存在。** 不检查 `MEMORY.md` 的权限，也不检查任何 Agent 能自己改动的文件：Agent 改动自己的文件，不应该让自己的命令全部失败。工作目录没有标记文件：它的路径记在 Agent 自己的文件里，只由创建流程生成。
5. 与架构无关的执行细节：进程组、僵尸进程判断、PID 复用防护、后台子进程占住输出管道时短暂等待后返回并标明、按序列化后的大小检查帧长度。 平台差异由一张表选择；Windows 用 `taskkill /T /F`，只能停止仍挂在活 shell 下的进程。macOS 用进程组存活检测，不区分僵尸或识别 PID 复用。
6. **谁在等结果，谁决定停。** 调用方中止 signal，网关就通知 node 停掉该次调用；暂停 Agent、连接断开和 node 正常关闭同样清理仍可追踪的命令。终止失败要报告，并保留句柄供关闭时重试。
7. **身份被拒绝时退出，网络失败时退避重连。** 网关拒绝 node 的身份或配对令牌时发 `gateway.refused`，直接运行的 node 进程以 78 退出，不重试（`unknown_identity` 而 node 手里有令牌时除外，见第 8 条）；网关因为用法出错结束连接（格式错误、顺序错误、握手超时、内部错误）时发 `gateway.error`，node 和连不上、连接中断时一样，从 250ms 起倍增、最多 10 秒重连。退出还是重连由消息类型决定，node 不维护错误码清单。systemd 用 `RestartPreventExitStatus=78` 停止重启；LaunchAgent 和计划任务直接执行 `node run --service`，服务入口将不可重试的 78 转为 0，保留错误日志。服务不靠 wrapper 等待子进程，所以服务的执行进程就是 node。
8. **先签名，令牌只在"不认识"之后用。** node 每次连接都先用签名认证，只有网关对这次认证明确回答 `unknown_identity`，才改用配对令牌；连不上、连接中断、握手超时都只是重连，下一次仍先用签名。配对令牌只存 SHA-256 哈希，只能用一次，过期作废。配对只会新增 node：已经配对过的 node ID 不能再配对，它的公钥不变，这次用的令牌也不算用掉。
9. **一个 node 一条连接，调用绑定在连接上。** 同一个 node 新认证的连接关闭旧连接。每个工具调用只接受发出它的那条连接送回的输出和结果；连接结束时，它带着的调用以"结果未知"结束并被忘掉，之后谁送来它的结果都不会交给调用方。
10. **违规的连接立即结束。** 未认证的连接最多 32 条，超出的直接关闭；单条消息按收到的序列化帧计不超过 1 MiB，超出的由 WebSocket 层关闭；无法解析、不认识的消息、认证前发别的消息、重复认证，网关回一个 `gateway.error` 后关闭连接，并且从这一刻起不再读取这条连接送来的任何东西，node 立即离线。心跳超时（TCP 没断但收不到数据也算）同样结束连接。

**持久化：** node 的身份密钥和配置存在 node 本地，和程序目录分开。POSIX 目录和私有文件分别用 0700、0600；Windows 存在当前账号的 `%LOCALAPPDATA%\Mate` 下，依靠该目录对普通账号的默认 ACL 隔离，不用 `chmod` 模拟 Windows 权限。网关的 node 注册表和配对令牌存在**控制库** `data/control.sqlite`，这个文件和 Web 外壳的登录、管理模块的 API key 共用：
- 网关结构第 2 版在 `nodes` 中加入唯一且非空的 `name`、完整系统报告的 `system_json` 和报告时间 `reported_at`。迁移给已有 node 起名 `node-<UUID 前 8 位>`；前缀相同的按 UUID 排序，第二个起加 `-2`、`-3`。公钥、配对时间和上次连接时间保留，系统报告和报告时间为空，等下次新格式握手补齐。
- 每个模块用 `@mate/control-store` 的 `openControlTables(dataDirectory, { module, migrations })` 打开自己的一条连接，关闭时只关自己的。文件名只在这个包里定义一次。
- 每个模块只建、只检查自己的表。结构版本记在 `schema_versions` 表里，每个模块一行（网关是 `gateway`）。模块的结构是一份 `Migrations`（`@mate/migrations`）：按版本递增的迁移列表。一个模块的版本比代码新、或不是列表里的版本，只有这个模块拒绝启动，抛出带文件路径的 `ControlStoreIncompatible`；别的模块照常打开。
- 打开时在同一个事务里把模块带到最新版本：没有记录就跑完整个列表并插入一行；记录在列表里的某个版本，就只跑它之后的迁移并更新这一行。迁移中途失败，事务回滚，存储留在原来的版本，拒绝启动。第一条迁移的建表用不带 `IF NOT EXISTS` 的 `CREATE TABLE`，表名和别的模块撞了同样拒绝启动，不会两个模块悄悄共用一张表。
- 文件由 `openControlTables` 以 0600 新建（SQLite 的 `-wal`、`-shm` 随主文件的权限），里面有密码哈希、登录会话和 API key；已有的文件不改权限。
- 每条连接都用 WAL、`synchronous=FULL`、5 秒 busy timeout。WAL 让一个模块开着读事务时别的模块照常提交。`node:sqlite` 是同步的，一个不 await 的事务在进程里别的连接开始事务之前就已结束，所以同一进程里的几条连接从不互相等待。规则是**控制库的事务里不 await**；busy timeout 只给进程外的读写者（备份、`sqlite3` 命令行）留余地。

**后台命令。** `bash` 带 `background: true` 时，runtime 在发起它的对话（主对话或工作助手）里建一个 Durable 后台任务，把这个任务的 ID 作为命令 ID 立即返回给模型。后台任务不让对话保持忙碌，也不随对话的 run 结束或被中止，所以 Agent 照常工作、照常空闲。这个任务把调用交给网关、等结果，步骤和 Durable 自己的工具任务一样：

1. 交给网关之前，先记下"已交给 node"。重新打开的 runtime 发现任务停在这里，就知道命令可能跑过：它可能被关闭停在半路，也可能已经跑完而结果没来得及记下。汇报"已中断"，如实写明这两种可能，不重跑。
2. 命令结束后，在同一次提交里结束任务、并为发起它的对话建一个投递（见 4.2 的"助手投递"），内容是结果的全部文本，开头一行写明命令 ID、成功还是出错、命令本身（`requestId = command:<ID>`，`whenBusy = "steer"`）。两件事一起提交，所以结果恰好汇报一次；发起它的是工作助手时，助手对汇报的回答也照常汇报给主对话。

后台命令的输出不流式显示，只在汇报里出现，截断规则和前台一样由 node 定。`bash_stop(ID)` 中止那个任务（Durable 的 `abortTask`），任务的 signal 随之中止，网关停掉 node 上的这次调用，和前台调用的停止走同一条路（规则 6）；被停止的命令不再汇报，`bash_stop` 的结果就是"已停止"。只能停自己这个对话的后台命令：不认识的 ID 返回错误结果；已经结束的命令返回普通结果，说明它已结束、结果会作为输入到达。命令结束和交出汇报是同一次提交，所以停止要么在它之前（不汇报），要么在它之后（命令已经结束）。`bash_stop` 可以重做：再停一次什么都不变，回答从任务的结局读出。runtime 关闭（暂停、控制面重启）时后台命令和前台命令一样被停掉，重新打开后那个任务以"已中断"汇报一次，不重跑命令。没有列出后台命令的工具：命令 ID 就在 `bash` 的结果里，压缩之后也能用历史工具查到。前台命令不给 `timeout` 时默认 10 分钟，最多 1 小时；后台命令不给时没有时限，最多一天。

### 4.6 管理模块

**职责：** 管理员用来管理 Agent 和环境：
- 创建、删除、暂停、恢复 Agent（调用 Agent Manager）；
- 设置模型、thinking 级别、说明文字（调用 `manager.configure`）；
- 管理各提供商的 API key；
- 配对 node，改 node 名字，查看在线状态和系统信息；
- 查看某个 Agent 的实时对话记录和工具调用（`watchEvents`）；
- 查看 token 用量；
- 浏览 Agent 的工作区。

**不负责：** 聊天。Agent 的显示名和 handle 归聊天账号，管理模块从聊天 app 读（`listAccounts()`），自己不另存；创建 Agent 时由 Manager 调 `ensureAccount` 开账号。

**它拥有 Agent Manager。** `openAdmin` 先打开自己在控制库里的凭据表，再打开 `data/agents/` 上的 Manager：Manager 的工作区宿主是网关（准备工作区调 `prepareWorkspace`，工作区端口的每次调用转给 `runTool`，带上调用的 signal），凭据查找读凭据表。所以 Web 外壳只组装聊天 app、网关和管理模块，不直接碰 Manager。

**对外接口（给 Web 外壳的 `/api/admin/*` 用）：**

```ts
// gateway 只需 nodes、renameNode、createPairingToken、prepareWorkspace、runTool、browse
openAdmin({ dataDirectory, chat, gateway, clock?, report? }): Admin
interface Admin {
  // 每个 Agent：聊天账号 ID、显示名和 handle（聊天账号的）、nodeId、nodeName、state（open | paused | closed）、settings、usage。
  // nodeName 每次从网关读，不写进 Agent 文件。
  // 文件读不出来的 Agent 以 state: "unreadable" 和 problem 列出，管理员可以删掉它
  agents(): AgentView[]
  createAgent({ agentId?, nodeId, displayName, handle, settings }): AgentId // node 必须已配对；名字、handle 和 agentId（必须是小写 UUID）在边界检查；中途失败时 reject AgentCreationFailed
  pauseAgent(id) / resumeAgent(id) / deleteAgent(id)
  configureAgent(id, settings) // 打开或关闭的都可以；打开的从下一次请求起生效
  assistants(id) // 打开的 Agent 的工作助手名字
  watchAgent(id, listener, { assistant? }): { stop(), ended } // 只能看打开的 Agent；暂停、删除或控制面关闭时 ended
  browseWorkspace(id, path) // 打开或关闭的都可以；返回 node 给的 listing，node 的拒绝原样成为 AdminError 的 reason
  providers(): { provider, name, credentials: { apiKey: "…末四位", baseUrl } | null }[] // 每个提供商一行
  setCredentials(provider, { apiKey, baseUrl? }) / deleteCredentials(provider)
  models() // 已存了 key 的提供商的模型目录，每个模型带它接受的 thinking 级别
  nodes() / createPairingToken() // 转给网关
  renameNode(nodeId, name) // 转给网关；GatewayError 转成相同 reason 的 AdminError
  close() // 关闭 Manager（所有 runtime），再关自己的控制库连接；网关和聊天 app 由 Web 外壳关闭
}
```

拒绝都是 `AdminError`，带 `reason`（`invalid-input`、`name-taken`、`unknown-agent`、`unknown-node`、`unknown-provider`、`no-credentials`、`unknown-model`、`unsupported-thinking-level`、`agent-closed`、`unknown-assistant`、`agent-exists`（用存在的 Agent 的 ID 创建），以及浏览工作区的 `node-offline`、`outside-workspace`、`not-found`、`unreadable`），被拒绝的操作什么都不改。聊天 app 对创建的拒绝（`handle-taken`，已删除 Agent 的 ID 的 `inactive-account`）以 `ChatError` 原样出来，因为那时什么都没创建。每个拒绝都是 `AdminError`（或上面这种 `ChatError`）：对 Agent 的操作排在该 Agent 的队列里执行，排队期间 Agent 被删掉，同样是 `unknown-agent`；观察时 Agent 被暂停或删除，是 `agent-closed`。

**模型和 API key：** 模型来自 pi-ai 自带的目录（runtime 的 `catalogModels`，Agent 的请求也在这个目录里解析）。管理界面提供 OpenAI（Responses API）和 DeepSeek 两家；凭据按提供商存 `{ apiKey, baseUrl? }`，`baseUrl` 替换目录里这个提供商所有模型的地址。设置模型时先检查（创建 Agent 时也一样，在任何东西被创建之前）：提供商是这两家之一、已经存了 key、目录里有这个模型、thinking 级别在这个模型接受的级别里。不接受的级别直接拒绝，不降级。runtime 每次模型请求都现读凭据，所以改了 key 从下一次请求起生效，再存一次同样的值不影响任何正在运行的 Agent；删了 key，这个提供商的请求不发出就失败。

**观察：** `watchAgent` 就是 runtime 的 `watchEvents`：Durable 的 agent 事件原样交出去，第一批是快照，之后是流式文字、工具调用和它们的输出、输入、用量。观察只读，不改变 Agent 的任何状态。关闭的 Agent 没有可看的，拒绝为 `agent-closed`。

**浏览工作区：** 管理模块按 Agent 文件里的 node ID 调网关的 `browse(nodeId, agentId, path)`，网关发 `gateway.browse`，node 回 `node.browse.result`。浏览不经过 runtime，所以暂停的 Agent 也能看。
- **只读，限定在工作区里。** 路径和文件工具一样由 node 上的工作区环境解析：相对于工作目录，或者是指向工作目录内的绝对路径；`..`、指向外部的绝对路径、指向外部的符号链接、悬空的符号链接一律以 `outside-workspace` 拒绝。node 只打开、读取、列目录，不写任何东西；打开文件不阻塞，所以 FIFO 以 `unreadable` 拒绝，而不是一直等。路径或工作目录不存在为 `not-found`，node 不会重建工作目录。
- **结果（listing，形状在 `@mate/node-protocol` 里定义一次）**，`path` 都是相对于工作目录的路径（工作目录本身是 `.`）：目录给出条目，按名字排序，每条是名字和种类（文件、目录、符号链接），文件带大小；文件给出大小和开头的文字；含 NUL 字节的文件只给大小，种类是 `binary`。
- **上限：** 文件最多返回开头 128 KiB（`BROWSE_FILE_BYTES`），截在完整字符处并标明 `truncated`；目录最多 500 条（`BROWSE_DIRECTORY_ENTRIES`），超出时标明 `truncated`，列出哪些由文件系统决定。这两个数让任何回答按 JSON 转义后的最坏情况仍在网关 1 MiB 的帧上限以内。
- **离线：** node 不在线、或者回答之前连接断开，网关立即回答 `node-offline`，不排队等待；之后迟到的回答被丢弃。和工具调用一样，回答只认发出请求的那条连接。

**持久化：** API key 存在 `data/control.sqlite` 里管理模块自己的 `provider_credentials` 表（模块名 `admin`），是唯一一份，runtime 每次请求现读。Agent 自己的配置存在该 Agent 的文件里。

### 4.7 Web 外壳

**后端（`apps/control-plane`）：** 负责组装、人类的登录和管理（谁能登录、角色、密码）、登录会话 cookie、HTTP 路由、事件流、推送发送器和前端静态文件。入口是 `startControlPlane({ dataDirectory, port?, host?, initialPasswordFile?, initialHandle?, webDirectory?, vapidSubject?, clock?, push? })`，`main.ts` 从环境变量读这些（`MATE_DATA_DIRECTORY`、`MATE_PORT`、`MATE_HOST`、`MATE_INITIAL_PASSWORD_FILE`、`MATE_INITIAL_HANDLE`、`MATE_WEB_DIRECTORY`、`MATE_VAPID_SUBJECT`），收到 SIGTERM 或 SIGINT 时关闭后退出。

- **组装。** 先打开外壳自己在控制库里的表（模块名 `shell`），再 `new ChatApp(chat.sqlite, { clock, push })`，建 `Humans`，第一次启动时创建第一个人类（见"登录"），建网关并把 HTTP 服务器上路径为 `/api/nodes/connect` 的 upgrade 交给 `handleUpgrade`（别的路径直接断开），最后 `openAdmin`。关闭时先停止 HTTP 服务（断开所有连接，事件流随之结束），再依次关闭管理模块、网关、聊天 app 和外壳的表。启动中途失败时，已打开的部分按相反顺序关闭。
- **登录。** 谁能登录由外壳自己的 `humans` 表管（`Humans`，控制库里的模块 `shell`）：每行一个人类，以聊天账号的 `externalId` 为键，带角色（`admin` 或 `member`）、scrypt 密码哈希和是否有效；显示名、handle 和账号种类在聊天账号里，聊天 app 不知道登录和角色，两边靠 `externalId` 对上。登录用 handle 加密码：控制面先让聊天 app 按 handle 找到人类账号（`findHuman`），再检查这个人类的密码。handle 不存在、是 Agent 的、或这个人类已停用，都和密码错了一样回 401 `wrong-password`（状态和正文都相同），并且照样做一次 scrypt 校验（对一个固定的假哈希），所以从回答和耗时都看不出哪些 handle 存在。**第一次启动**（`humans` 表是空的）：从 `initialPasswordFile` 读初始密码（去掉末尾换行，至少 12 字节；没有这个文件就拒绝启动），用 `initialHandle`（`MATE_INITIAL_HANDLE`，缺省 `admin`，要符合聊天账号的 handle 规则，否则拒绝启动）建聊天账号（`externalId: "human:initial"`，`kind: "human"`，显示名同 handle），再插入管理员行；两步都以这个固定的 `externalId` 为键，所以停在两步之间，下一次启动会补完。有了第一个人类之后再也不读这个文件。同时进行的密码校验最多 2 个，更多的按到达顺序排队（先进先出，空出的名额直接交给队首），不拒绝；队列最长 64，超出的立即回 429（`Retry-After: 1`）；排队超过 10 秒仍未轮到的也回 429。不做锁定，也不按客户端计数，所以连续输错再多次，正确的密码也进得来。上限是有意的取舍：几十个并发客户端持续把 64 的队列填满时，一次正确的登录也可能回 429，重试即可；已有的登录会话不受影响，也不会因此被锁定或泄露什么。密码对了之后才开会话，而且这一步要求这个人类仍然有效、密码哈希和角色仍是检查时的那一份（插入会话的语句本身带这个条件），所以在队列里等待期间被改了密码、改了角色或被停用的人类，那次登录回 401 `wrong-password`。登录成功发一个随机令牌，cookie 为 `__Host-mate_session`（`HttpOnly; Secure; SameSite=Lax; Path=/`），库里只存令牌的 SHA-256 和它属于哪个人类；登录会话从登录起 30 天有效，不随使用延长，跨重启保留，并且只对有效的人类有效。退出登录删掉这一行，令牌立即失效，别的登录会话不受影响。**会话是人类权限的快照**：角色变了（改角色，或自己降级）、密码被重置、人类被停用，都结束这个人类的全部登录会话（改自己的密码时当前这个除外），所以降级的管理员开着的管理事件流在下一个事件或心跳以 `login` 结束，旧 cookie 回 401；设成原来就有的角色什么都不改。
- **人类的管理。** 每个人类可以改自己的显示名、handle 和密码；管理员还能添加人类、改人类的角色（包括自己的，只要不是最后一个管理员；改完自己的会话随之结束，前端的下一个请求回 401 就跳到登录页）、重置别人的密码和停用别人。任何时候至少有一个有效的管理员：降级或停用最后一个有效管理员回 409 `last-admin`，什么都不改。停用是永久的（同聊天的 `deactivateAccount`）：先在外壳标记无效并删掉这个人所有的登录会话，再停用聊天账号，所以这个人开着的事件流在下一个事件或心跳发出前就以 `login` 结束，登录也立即不可能；已经标记无效而聊天账号还没停用（中途崩溃）时，重做同一个请求会补完。其消息照常可读。添加人类以管理员给的 `requestId` 幂等：externalId 是 `human:request:<requestId>`，外壳里已有这一行就原样返回这个人类，不再改动（包括这个人后来自己改的名字）；没有就先建聊天账号（handle 被占用在任何外壳写入之前就拒绝），再插入外壳的行，两步之间崩溃，重发同一个请求会补完。
- **路由。** 除了 `POST /api/login`（`{ handle, password, next? }`，回 `{ next }`：`next` 是站内 `/app` 下的路径时原样返回，否则是 `/app`）和 `POST /api/logout`，`/api/*` 都要登录，未登录回 401。页面请求：前端目录里存在的文件（脚本、样式、图标）不需要登录；`/` 跳到 `/app`；`/app` 及其下的页面未登录时跳到 `/login?next=<原地址>`；其余页面路径都回前端的 `index.html`，由前端路由。没有前端目录时页面回 404，API 照常工作。
  - `/api/chat/*` 一个路由对应聊天 app 的一个操作，账号固定为发出请求的人类自己的账号：每个人类读到全部会话，有自己的实时视图、未读摘要和推送订阅。读：`GET snapshot`（可带 `conversation=` 或 `thread=`）、`conversations`、`unread`、`history`（`conversation=`/`thread=`、`before`、`limit`）、`search?q=`。写都带浏览器生成的 `requestId`：`POST read`（读未读，推进这个人类的已读位置）、`messages`、`channels`、`dms`、`conversations/:id/join|leave|archive|invite`、`tasks`、`tasks/:id/change`。发送和任务操作总是关闭新鲜度检查（4.1 规则 2），请求里不接受这一项。推送：`GET push/key`（VAPID 公钥）、`POST push/subscribe`、`POST push/unsubscribe`。
  - `/api/me`：`GET` 回 `{ accountId, handle, displayName, role }`；`PATCH { displayName, handle }` 改自己的名字（经聊天 app 的 `ensureAccount`，handle 被占用回 409 `handle-taken`）；`POST password { current, next }` 改自己的密码（`current` 不对回 403 `wrong-password`，`next` 至少 12 字节），自己其他的登录会话随之结束，当前这个保留。
  - `/api/humans`（只有管理员）：`GET` 回每个人类的 `{ accountId, handle, displayName, role, active }`；`POST { requestId, handle, displayName, password, role }` 添加；`POST :accountId/role { role }`（结束那个人类所有的登录会话）、`POST :accountId/password { password }`（结束那个人类所有的登录会话）、`POST :accountId/deactivate`。
  - `/api/admin/*`（只有管理员）一个路由对应管理模块的一个操作：`GET|POST agents`、`POST agents/:id/pause|resume`、`DELETE agents/:id`、`PUT agents/:id/settings`、`GET agents/:id/assistants`、`GET agents/:id/events`（事件流，可带 `assistant=`）、`GET agents/:id/workspace?path=`、`GET providers`、`PUT|DELETE providers/:provider/credentials`、`GET models`、`GET nodes`、`PUT nodes/:id`（`{ name }`，改名字）、`POST pairing-tokens`。
  - **跨站防护。** 请求体必须声明 `content-type: application/json`（可带 charset），否则回 415 `unsupported-media-type`：别的站点的表单或不预检的 `fetch` 只能发 `text/plain` 之类，所以带着人类的 cookie 也伪造不出请求。带 `Origin` 头的非 GET 请求，`Origin` 的 host 必须等于请求的 `Host`，否则回 403 `cross-origin`（登录、退出也一样）；没有 `Origin`（脚本、curl）不是浏览器页面发的，放行。路径参数里不合法的百分号编码回 400 `invalid-input`。
  - 请求体交给聊天 app 或管理模块原样解析，外壳只检查它是一个 JSON 对象。拒绝回 `{ error, message }`，`error` 就是 `ChatError`/`AdminError` 的 `reason`，状态码按 reason 固定：`invalid-input`、`invalid-target`、`unknown-model`、`unsupported-thinking-level` 为 400；`not-found`、`unknown-account`、`unknown-agent`、`unknown-node`、`unknown-provider`、`unknown-assistant` 为 404；`not-member`、`inactive-account`、`human-only`、`outside-workspace` 为 403；`archived`、`request-conflict`、`handle-taken`、`name-taken`、`no-credentials`、`agent-closed`、`agent-exists` 为 409；`unreadable` 为 422；`node-offline` 为 503。外壳自己的拒绝：`admin-only`（普通人类调用管理员的路由，在读请求体之前）403，`wrong-password` 在登录时 401、在改密码时 403，`last-admin` 409，`too-many-attempts` 429，`unknown-account`（`:accountId` 不是人类）404。创建 Agent 在文件改名之前中途失败回 500，`error: "creation-failed"`，带上 `agentId`，客户端用它重做；没有创建任何东西的拒绝（不合法的名字、handle 被占用、ID 已存在）回上面各自的状态，不带 `agentId`。成功的操作回 200 加结果，没有结果的回 204。
- **事件流。** 用 SSE。`GET /api/chat/events?cursor=<快照的游标>`：每次 `liveEvents` 读到的一批是一个 `events` 事件（数据就是 `{ status, events, cursor, unread }`），SSE 的 id 是这批读到的游标 `cursor`，所以 EventSource 断线重连带着 `Last-Event-ID` 正好从那里接着读（`Last-Event-ID` 优先于 `cursor`）。读完一轮就等 `watchLive` 的信号；读的过程中来的信号让它读完再读一轮。游标接不上时发 `resnapshot` 并关闭，客户端重新拉快照、用新游标重连。每个事件发出之前、读聊天 app 之前都查一次登录会话；会话已过期、已退出登录或这个人类已被停用，就发 `login` 并关闭，之后什么都不发。没有事件可发时，每 25 秒发一行注释作心跳，心跳前同样查会话，所以空闲的流在会话结束后 25 秒内关闭。`GET /api/admin/agents/:id/events` 是 `watchAgent` 的事件流：每批 agent 事件一个 `events` 事件，第一批是快照；观察结束（暂停、删除、控制面关闭）时发 `ended` 并关闭；登录会话的规则相同。Agent 没有打开时在流开始之前就以 409 拒绝。
- **推送发送器。** VAPID 密钥对在第一次启动时生成，存在外壳的表里，之后不变：浏览器用公钥订阅，换了密钥所有订阅都会失效。`PushSender` 用 `web-push` 发出（加密、VAPID 签名、TTL 一天、请求超时 10 秒），推送服务的回答原样作为状态码交回聊天 app，连不上时抛错。VAPID 的联系地址来自 `MATE_VAPID_SUBJECT`，缺省为 `mailto:owner@mate.invalid`。

**前端：** 一个网页应用，里面挂两个功能区：聊天和管理。用户感觉是一个应用，实现上是两个互不 import 的前端模块，只共享外壳提供的登录状态、导航和布局。服务端数据统一用一个数据请求库（TanStack Query）获取和缓存，不在页面组件里手写请求和缓存逻辑。样式用 Tailwind CSS v4，对话框、菜单、标签页等交互组件用 Base UI，界面原语集中在 `src/shell/ui.tsx`；外观和交互规则见 [界面规范](DESIGN.md)。页面在 `/login` 和 `/app` 下：聊天（`/app`、`/app/c/…`）、搜索、个人资料（`/app/profile`：改显示名和 handle、改密码、退出）、管理（`/app/admin/agents|providers|nodes|humans`，人类页让管理员添加人类、改角色、重置密码、停用）。当前人类来自 `GET /api/me`，导航据此显示名字和头像，普通人类不显示管理入口，直接打开管理地址显示"需要管理员权限"；当前人类自己的账号在实时流里变化时这份数据重新获取。`apps/web` 用 Vite 构建，`MATE_WEB_DIRECTORY` 指向构建产物（`apps/web/dist`）。

- **node 名字只用于显示。** Node 页显示名字、在线状态和最近一次系统信息；没有报告时显示尚未收到。改名失败贴在名字字段下面，保存成功后同时刷新 node 和 Agent 查询。创建 Agent 的选择项显示名字，提交仍用 node ID；Agent 列表显示从网关读取的 `nodeName`。
- **每条时间线一个查询，条目按序号存放。** 重复或重放的实时事件落在同一个序号上，既不会多出一条消息，也不会让讨论串的回复数虚增（回复数是已见回复序号的集合）。实时事件只更新已经存在的时间线查询；一条时间线的第一页还在加载时到达的条目先暂存，页面到达后并进去。
- **打开页面时的会话在事件流之前确定。** 先按地址里的会话拉快照（`GET snapshot?conversation=`），用快照填缓存，再从快照的游标起开事件流。`resnapshot` 清掉聊天缓存、重新拉快照后重连；`login` 跳到 `/login?next=`；任何 API 的 401 也一样。
- **发送带浏览器生成的 `requestId`，失败后重试沿用同一个。** 草稿和未完成的发送放在页面之外的模块里，切换会话或重新加载状态都不丢；发送成功只从输入框里去掉已发送的那部分，发送期间又输入的文字保留。拒绝（4xx）说明什么都没发生，下一次发送是新请求。
- **看到就是读过。** 打开的时间线上有未读时，页面向 `POST read` 报一次（每个最新序号一次），已读位置由此前进。
- **推送。** 开启通知时注册 `sw.js`，用 `GET push/key` 的公钥订阅，再 `POST push/subscribe`。退出登录时先取消这个浏览器的订阅（`POST push/unsubscribe`，再取消浏览器自己的订阅），失败也照常退出，所以同一个浏览器上下一个登录的人类不会收到上一个人类的通知；服务端另有保底：另一个人类再订阅同一个 endpoint 时订阅归这个人类，前一个人类排队的推送被丢弃。通知点开后进 `/app/c/:会话[/t/:讨论串]?seq=N`；那条消息不在时回到最新消息并提示。
- **提醒后端的缺口**（前端据此降级）：历史条目不带回复数，所以讨论串的回复数只统计本次页面见过的回复；搜索结果不带会话和时间线，所以不能点进去；没有列出任务的接口，任务只在所属消息和时间线上显示。

## 5. 关键流程

### 5.1 人类发消息，Agent 回复

1. 人类在 #general 发了一条 @A 的消息。浏览器带上自己生成的 `requestId`。
2. 聊天 app 在一个事务里写入消息，并给 A 和其他成员追加收件事件（A 的那条带"提及"标记）。
3. A 的连接器看到新事件，生成通知并提交给 A 的 runtime。
4. A 空闲，所以 Durable 开始一次 run。模型看到通知，决定调用 `readUnread(#general)`。
5. 聊天 app 返回消息，推进 A 的已读位置，并按工具调用 ID 存下回执。
6. 模型调用 `send(#general, ...)`。期间没有别人发新消息，发送成功。

### 5.2 运行中来了新消息

A 正在执行一条长命令时，B 在 #dev 发了消息。连接器提交一条 `steer` 通知，Durable 把它插在当前这轮工具调用之后。之后 C 又发了一条：连接器撤回那条还没交给模型的通知，换成新的"至少 2 条"。

### 5.3 发送被拦下

A 读完 #general 之后、发送之前，人类又发了一条。A 的 `send` 返回"未发送：你上次读取后有 1 条新消息"，附上那条消息，并推进 A 的已读位置。A 可以改了再发，或者原样再发。

### 5.4 暂停与恢复

管理员点了暂停。Manager 在 A 的队列里执行：关闭 runtime（中止模型请求，请网关停掉 A 在 node 上的调用），然后在 A 的文件里记下"已暂停"。恢复时清除这个标记，打开 runtime，Durable 从停下的地方接着跑，被中止的工具调用以"已中断"交给模型。

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
  control.sqlite              人类的角色和密码哈希、登录会话、VAPID 密钥、API key、node 注册表（名字、系统信息和身份，0600）
  chat.sqlite                 聊天 app 的全部数据（含附件元数据和推送队列）
  attachments/                附件文件（还没有实现）
  agents/<agentId>.sqlite     每个 Agent 的 Durable 存储（含配置、提醒、连接器位置）
```

搬到另一台 VPS：停掉容器，复制 `data/`，启动。

**结构迁移。** 每个存储的结构就是一串按版本递增的迁移（`@mate/migrations` 的 `Migrations`），没有另一份"当前建表语句"：新存储跑完整个列表，已有的存储只跑比它的版本新的迁移，所以新建的和升级来的结构不会分叉。启动时在一个事务里迁移，失败就回滚，存储留在旧版本并拒绝启动；存储比代码新、或停在列表里没有的版本，同样拒绝启动，并且不改动文件。`chat.sqlite` 的版本记在 `PRAGMA user_version`，迁移列表在 `packages/chat/src/chat-migrations.ts`（第 3 版是第一条，1、2 从未发布；第 4 版把账号的 `role` 换成 `kind`：原来的所有者成为人类、其余成为 Agent，并给实时事件加受众、给推送订阅加账号）；迁移时外键关闭，以便重建表，提交前用 `foreign_key_check` 确认没有悬空引用。`control.sqlite` 由几个模块共用，版本按模块各记一行，见 4.5；外壳的第 2 版用 `humans` 和 `sessions` 取代 `owner_password` 和 `owner_sessions`：原来的所有者成为 externalId 为 `owner` 的管理员，密码哈希和登录会话原样保留（已登录的 cookie 继续有效），这个账号的聊天账号本来就是 externalId `owner` 的人类账号，名字和 handle 不变，之后可以自己改。网关的第 2 版为已有 node 加名字和空的系统报告，身份与公钥不变，详见 4.5。升级是否可行由**存储夹具**证明：用 `scripts/make-store-fixture.ts` 从已发布的版本生成真实的数据目录，放在 `tests/fixtures/stores/<版本>/`，测试在它的副本上启动新代码。

## 7. 部署

- **控制面**：Docker 镜像加单服务 Compose，容器以一个专用的无登录系统账号的 UID/GID 运行，数据目录只属于它。node 账号（Agent 命令的身份）读不到模型凭据和对话库，也不在 docker 组里。
- **node**：完整发布包，自带 Node 运行时和 `mate node` CLI，以宿主现有账号运行。Linux 用 systemd 用户服务，macOS 用当前图形登录账号的 LaunchAgent，Windows 用当前账号的登录计划任务。每个平台分别发布 x64 和 arm64 包，文件名的平台为 `linux`、`darwin`、`win`。发布包是 ustar 归档加旁边的 `.sha256`，装入已钉住官方校验和的 Node 24 二进制、esbuild 打包的程序、启动命令和清单。Windows 的官方 ZIP 只提取运行时与许可证；清单中的平台为 `win32`。CLI 校验平台和架构，不匹配就拒绝。包由管理员自行下载；自动部署仍只升级 Linux 的同机 node。
- **`mate node` 不记"做到哪一步"**（第 11 节第 1 条）。程序目录（POSIX 的 `~/.local/lib/mate-node`、Windows 的 `%LOCALAPPDATA%\Mate\program`）由暂存目录改名放入、改名挪开再删，所以要么是完整的某个版本，要么不存在；`install`、`update`、`uninstall` 只看程序目录、`mate` 命令、服务定义和服务状态这几样现有状态决定做什么，配置、身份和工作区在程序目录之外，它们从不碰。清单同时说明程序目录里哪些文件是 Mate 的：有别的文件时 `update` 和 `uninstall` 拒绝，不删别人的东西。`install` 从不启动服务，`update` 只在服务完全停止时动手，之后也不启动。状态到动作的完整对照见 DEPLOYMENT §3.2。

Mate 不创建用户、不切换身份、不安装系统软件、不配置 linger。Agent 自己在命令里写 `sudo` 的话，能不能成功由宿主的 sudo 策略决定。

## 8. 测试策略

只在**模块边界**测试，不写单元测试。每个模块从它对外的接口驱动，边界外的依赖用替身代替：
- 模型：一个脚本化的提供商，跑在真实 HTTP/SSE 上；
- node：假的 node 连接；
- 时钟：可控制的时钟；
- 存储：临时文件。

失败和恢复路径与正常路径同等重要：在指定的提交点之前或之后崩溃，再重启。每个模块具体测什么，写在 [MODULE_TESTS.md](MODULE_TESTS.md)。

## 9. 旧问题在新结构下为什么不会出现

| 旧问题 | 旧做法 | 新结构 |
|---|---|---|
| 操作回执对账在每一代 runtime 都出错：一个操作的状态散在 4 个以上的地方 | 控制面账本、node 两种回执存储、内存里的待处理请求表、定期核对 | 控制面从不重发；断线就是"结果未知"；Durable 不重放有副作用的工具。没有回执，也就没有对账 |
| 每个副作用边界都要检查"这个 run 还有效吗" | 数据库里的 run 记录、唯一索引、每处重新检查 | 没有 run 记录。暂停就是关闭 Harness，运行中的代码随之中止 |
| run 生命周期写在构造函数里，靠 250ms 轮询推进 | 一个轮询循环同时处理提醒、忙碌通知和退避 | 事件驱动：连接器响应事件，提醒用定时器，重试交给 Durable |
| OwnerChat 是一个什么都管的大服务 | 消息、投递、run 完成、提醒共享事务 | 聊天 app 只管聊天事实，不知道 run |
| "这条投递被 Durable 收下了"的确认，可能在两个库之间丢失 | 业务库确认 + 恢复时对账 | 事件 ID 就是 `requestId`，Durable 去重，不需要确认 |
| 忙碌通知可能饿死、重复，被撤回后丢失 | SQL 排除已通知的、内存备忘、后继 ID | 同一时间最多一条没交给模型的通知，新的替换旧的 |
| 新鲜度用"最高序号"实现，被只读最新一页绕过 | 改成逐条记录"给谁看过哪些" | 只能从已读位置往后读；跳过的区间在结果里明确交代 |
| 读取推进了已读位置，但工具结果没提交就崩溃，导致丢一页 | 读取和"已展示"写在同一事务里 | 按工具调用 ID 存读取回执，重做时原样返回 |
| 改配置后要用配置哈希作废已准备的请求 | 哈希、全部中止、重新配置 | 不追溯，下一次请求起生效 |
| 用量统计反复重写 | 从原始 SSE 里抠数字 | 只读 Durable 的 `pi.usage`，只做观察 |
| Agent 改了 `MEMORY.md` 的权限，自己的命令就全部失败 | 每次执行前检查 Agent 能改的文件 | 只检查工作目录是否存在 |
| 人类重发消息会产生重复消息 | 没有幂等键 | 浏览器生成 `requestId` |
| 浏览器的事件游标超前于服务端时检测不到 | 只检查游标是否太旧 | 事件流带一个"纪元"ID，数据重置后纪元改变，客户端重新拉快照 |
| 提醒是否已处理靠两个时间戳相等来判断 | `completed_at = handled_at` | 提醒存在 Agent 的 Durable 文档里，触发时按 `reminder:<id>` 去重 |
| 一个 Agent 同时可能有两个 runtime | 关闭旧 Harness 后才能打开新的这条规则 | Manager 是唯一的构造者，每个 Agent 一条串行队列 |

## 10. 不变的产品决定

下面这些是产品层面的前提，改架构时不重新讨论：
- 每个 Agent 一个主上下文，跨频道、讨论串、私信延续；不同 Agent 的上下文互相独立。
- 模型的普通输出不发到任何地方，发言只通过发送工具。
- 不设 token、费用、run 次数配额。
- 不做逐条命令审批，不做 Mate 自己的提权。
- 不限制 Agent 读同事的工作区，只在提示里请它不要读。
- 不使用 `pi-coding-agent`。
- 几个人共用，每人自己的登录；角色只有管理员和普通人类两种（管理员管理 Agent、提供商和 API key、node 和其他人类，普通人类只聊天）；中文界面，适配手机。
- 规模很小：几个人，少量 Agent（模型费用决定了不会多），消息量不大。不为数据量做性能优化或分页之类的设计，除非测量证明确实有问题；结构简单优先。

## 11. 决定记录

下面这些决定各自写明它落在本文哪里。

| # | 问题 | 决定 | 落在 |
|---|---|---|---|
| 1 | node 安装器要不要一套可续做的文件状态机？ | 不要。`mate node` 的每个命令都从现有状态推出该做什么，不记"做到哪一步"：程序目录整个替换，配置、身份和工作区放在程序目录之外，从不被安装、更新、卸载动到。中途失败就重跑同一个命令；重跑不了就删掉程序目录重装，Agent 的 `MEMORY.md` 等资料不会丢 | 4.5、第 7 节、MODULE_TESTS 第 9 节 |
| 2 | 接哪些模型提供商？ | 走 pi-ai 自带的模型目录，不自己写协议。管理界面提供 OpenAI（Responses API）和 DeepSeek（例如 `deepseek-flash`，用于便宜地测试）。API key 按提供商存 | 4.6 |
| 3 | 上下文压缩用哪个模型？Agent 知不知道被压缩？ | 用 Durable 自带的压缩（`settings.compaction`），摘要由这个对话自己的模型写，失败或被截断的摘要不生效，Durable 保证。被压缩掉的记录仍在存储里，历史工具读它们；历史扩展的系统提示告诉 Agent "更早的记录可以用历史工具查" | 4.2 |
| 4 | bash 没有时限时会一直占着 Agent，要不要默认上限？ | 参照 Claude Code 的后台命令：`bash` 加 `background` 参数。前台命令默认 10 分钟、最多 1 小时，跑命令期间 Agent 不处理别的；后台命令立即返回一个命令 ID，Agent 继续工作，命令结束时结果作为一条输入（`command:<ID>`）提交给发起它的对话（主对话或工作助手），可以用 `bash_stop` 停掉。后台命令最多跑一天 | 4.2、4.5 |
| 5 | node 注册表放 `nodes.sqlite` 还是 `control.sqlite`？ | 统一放 `control.sqlite`，尽量少分文件。控制面里的网关、登录和管理模块共用这一个文件，各自建自己的表 | 4.5、4.6、第 6 节 |
| 6 | 一个 Agent 用哪个 node？ | 创建 Agent 时从已配对的 node 列表里选一个，只有一个就只能选它。node ID 记在 Agent 自己的文件里，之后不变 | 4.4 |
| 7 | 要不要 Web Push 和附件？ | 要推送；聊天接口接受附件元数据，但附件文件的上传和存储还没有实现 | 4.1 |
| 8 | 数据库结构变了怎么升级？ | 原地向前迁移：每个存储的结构是一串按版本递增的迁移；比代码新、或版本不在列表里的存储拒绝启动；已发布版本的存储夹具证明升级可行 | 第 6 节、4.5 |
| 9 | 要不要 CI？ | 要。GitHub Actions 对每个 PR 和 main 各检查一次：`pnpm check` 和 `pnpm test:linux` 的内容拆成几个并行任务（格式与类型、node 和系统场景以外的测试、两片 `test:linux`、`mate-deploy` 的测试），node 套件另在 macOS 和 Windows 原生 runner 上运行，并用本机实际发布包验证服务，汇总成一个 `checks` 结果；`v*` 标签不重跑，等这个提交在 main 上的 `checks` 通过后发布镜像和 node 发布包，设了部署主机时再自动部署（失败回退到原版本和部署前的数据备份） | `.github/workflows/ci.yml` |
| 10 | 几个人怎么共用？ | 每个人是一个人类账号，各有登录（handle 加密码）、名字、已读位置和推送。角色只有管理员和普通人类两种：角色和登录归外壳的 `humans` 表，名字和账号种类归聊天 app，两边靠 externalId 对上。任何时候至少有一个有效的管理员；第一个人类（管理员）由初始密码文件和初始 handle 在第一次启动时创建；原来的所有者升级后成为 handle 为 `owner` 的管理员 | 4.7、第 6 节 |
| 11 | 怎样区分配对的机器，又不让改名影响身份？ | UUID 继续用于配对、认证、工具调用和 Agent 文件；网关保存唯一的 node 名字及 node 握手报告的系统信息，管理员只改名字。Agent 列表从网关现查名字 | 4.5、4.6、4.7、第 6 节 |
| 12 | node 支持哪些平台，Windows 用什么 shell？ | Linux、macOS、Windows，分别支持 x64 和 arm64。平台表选择 shell、进程管理、服务、布局、权限和路径规则，公共安装与命令流程不复制。Windows 用自带的 PowerShell 5.1，进程树追踪范围见 4.5；macOS 和 Windows 由管理员手动安装，不加入 Linux 的自动部署 | 4.5、第 7 节、DEPLOYMENT §3.2 |
