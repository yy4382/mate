# 术语表

本项目在文档、代码和对话里统一使用下面这些词。每个词后面括号里是代码中使用的英文名。「避免」列出容易混淆、不应该用来指代这个概念的说法。

## 人与 Agent

**所有者**（owner）
使用 Mate 的那一个人。在聊天 app 里，所有者是一个能看到所有会话的账号；在 Web 外壳里，所有者是唯一能登录的人。

**Agent**（agent）
一个长期存在的 AI 同事。它有稳定的 Agent ID、一个聊天账号、一个工作区和一个 runtime。一次模型调用、一次 run 或一个工作助手，都不是新的 Agent。

**Agent ID**（agentId）
创建 Agent 时生成的唯一标识，之后永不改变。它同时用作 Agent 存储文件的文件名，以及 Agent 聊天账号的 `externalId`。
避免：名字、handle（它们可以改）。

## 聊天 app

**聊天 app**（chat）
Mate 内置的类 Slack 聊天系统。它不知道 runtime 和模型的存在。

**账号**（account）
人或 Agent 在聊天 app 里的身份。聊天 app 不区分账号背后是人还是 Agent。

**会话**（conversation）
频道或私信。
- **频道**（channel）：分公开和私有。公开频道不加入也能读，私有频道只有成员能读。
- **私信**（dm）：两个账号之间的会话，每一对账号只有一个。

**时间线**（timeline）
一串按顺序编号的条目。每个会话的顶层是一条时间线，每个讨论串也是一条时间线。

**讨论串**（thread）
挂在某条顶层消息下面的回复，自成一条时间线。

**条目**（entry）
时间线上的一项，分两种：
- **消息**（message）：账号发出的内容，不能编辑或删除。
- **任务条目**（task entry）：某个任务的一次变化，比如创建、认领、让出、转交、完成。

两种条目共用一套序号。

**序号**（seq）
条目在所属时间线里的位置，只增不减。

**任务**（task）
挂在某条消息上的一件工作。一条消息可以有零到多个任务。拥有任务不额外授予任何权限。

**已读位置**（read position）
某个账号在某条时间线上读到的序号。它是聊天 app 记录"谁看过什么"的唯一方式。只有按顺序往后读才会推进它；回看历史和搜索都不会推进它。
避免：presented、seen、watermark（旧设计里的多套状态）。

**预算**（budget）
一次读取最多返回多少内容，按字符数和附件大小一起计算。未读内容超出预算时，返回最新的、放得下的部分，并说明跳过了哪一段。

**新鲜度检查**（freshness check）
发送或做任务操作前，服务端检查这条时间线上有没有别人新写的、但发送者还没读到的条目。有的话就不执行，并把这些条目返回。是否做这项检查由调用方的程序决定，模型无从选择。
避免：hold、草稿（新设计不保存被拦下的内容）。

**收件事件**（inbox event）
有人发了一条该通知某个账号的消息时，聊天 app 为这个账号写下的一条记录，和消息在同一个事务里提交。事件 ID 全局递增。任务条目不产生收件事件。

**未读摘要**（unread summary）
某个账号当前各条时间线的未读数量，以及其中有没有 @ 自己的消息。每条时间线还带上会话类型、显示名（频道名；私信为对方的 handle）、是否讨论串和最新一条未读的发送者，足够直接渲染一条通知。

**收件信号**（inbox signal）
聊天 app 在一次写操作提交、并且这次写追加了收件事件之后发出的提醒，只带收到事件的账号，不带事件本身。它只是"该去读收件事件了"的提示，连接器仍然从自己的事件位置往后读，所以错过一次信号不会丢事件。

**requestId**
调用方为一次操作生成的稳定 ID。接收方按它去重：同一个 ID 只生效一次，重复调用返回第一次的结果。Agent 的工具调用用 Durable 的工具调用 ID 作为 requestId；所有者的网页请求由浏览器生成。

## Agent runtime

**runtime**（agent runtime）
运行一个 Agent 的组件。它包装一个 Durable Harness，加上 Mate 的扩展。每个 Agent 一个 runtime、一个存储文件。

**Durable**
`@earendil-works/pi-durable` 库。它负责 agent loop、重试、对话记录、收件箱和上下文压缩。

**Harness**
Durable 里"一个存储，加上在这个存储上运行 agent 的机制"。runtime 打开时打开它，关闭时关闭它。

**主对话**（primary conversation）
一个 Agent 的主上下文。它在所有频道、讨论串和私信之间延续，只有它能使用聊天工具。
避免：session（在聊天语境里有歧义）。

**工作助手**（assistant）
Agent 派生出来的另一个 Durable 对话，有自己的上下文。它和主对话共享模型设置、凭据和工作区，没有聊天工具，完成后向派生它的对话汇报。它不是新的 Agent。

**收件箱**（inbox）
Durable 为每个对话维护的输入队列。外界给 runtime 的所有输入都提交到这里：通知、提醒、助手汇报。Agent 正在运行时，以 steer 方式提交的输入会插在当前这轮工具调用之后。

**run**
从一条输入开始，到模型给出最终回答为止的这段工作。run 只是 Durable 内部的概念，Mate 不记录它，也不检查它"是否仍然有效"。

**扩展**（extension）
装进 Durable 的一组工具和系统提示片段，比如聊天、工作区、提醒、助手、历史。

**可重做**（replay-safe）
声明了 `replay: "safe"` 的工具，崩溃后会被重新执行。只有只读的工具，或者按 requestId 幂等的工具才能这样声明。

**已中断**（interrupted）
没有声明可重做的工具在执行中遇到崩溃或关闭，Durable 告诉模型的结果。这次调用不会被重新执行。

**结果未知**（unknown result）
node 工具调用进行中连接断开时，返回给模型的结果：命令可能执行了，也可能没有，不会重试。

**聊天端口**（ChatPort）
runtime 自己定义的、绑定到 Agent 账号的聊天操作接口，聊天工具只通过它调用聊天 app。Agent Manager 把 `ChatApp` 绑定到账号来实现它。runtime 不 import 聊天 app。

**游标**（cursor）
runtime 存在自己 Durable 存储里的一个命名位置，只进不退，比如连接器在收件事件里处理到的事件 ID（`chat-inbox`）。

**提醒**（reminder）
Agent 给自己设定的定时输入，保存在它自己的存储文件里，到时间后提交到主对话的收件箱。

## 环境与控制面

**控制面**（control plane）
运行在 Docker 容器里的单个进程，包含 Web 外壳、聊天 app、管理模块、Agent Manager、所有 runtime 和 node 网关。

**Web 外壳**（shell）
负责登录、HTTP 路由，以及把聊天和管理两个前端功能区挂在同一个网页里。

**管理模块**（admin）
所有者用来创建和配置 Agent、管理 API key、配对 node、查看对话记录和用量、浏览工作区的模块。

**Agent Manager**（manager）
唯一能打开和关闭 runtime 的模块。一个 Agent 存在，当且仅当它的存储文件存在。

**暂停**（pause）
关闭一个 Agent 的 runtime，并在它的存储文件里记下"已暂停"。恢复就是清除这个记录，重新打开 runtime。

**连接器**（connector）
把一个 Agent 账号的收件事件变成它 runtime 收件箱里一条通知的组件。

**通知**（notice）
连接器提交给 runtime 的一条不含消息正文的提示，写明截至某个时间点至少有多少未读、分布在哪里、有没有 @ 你。同一时间最多只有一条还没交给模型的通知，新的会替换旧的。

**node**
以宿主机现有账号运行的执行进程，由 `mate node` CLI 管理成 systemd 用户服务。它在 Agent 的工作区里执行命令、读写文件，不接触模型凭据和对话记录。

**工作区宿主**（WorkspaceHost）
Agent Manager 看到的"工作区在哪里"：为一个 Agent 准备工作区（可以重复调用），以及给出这个 Agent 的工作区端口（`WorkspacePort`）。由 node 网关实现；测试里用假的。

**node 网关**（node gateway）
控制面里负责 node 配对、认证、心跳，并把工具调用整个转发给 node 的模块。

**工作区**（workspace）
Agent 在 node 上的工作目录。Agent 在里面自由组织记忆、文件和脚本。

**MEMORY.md**
工作区里的一个文件，是 Agent 恢复时读的第一个入口。它只是一个约定，Mate 从不检查它。

## 共用基础

**时钟**（clock）
`@mate/clock` 里的 `Clock`：读当前时间（`now`），以及睡到某个时长或某个 `AbortSignal` 中止为止（`sleep`）。所有需要时间或定时器的模块都通过它，而不是直接调用 `Date.now` 或 `setTimeout`；一个定时器就是一次带自己 signal 的 `sleep`，中止 signal 就是取消它。测试里换成**可控时钟**（`FakeClock`），由测试推进时间。
避免：timer handle、setTimeout 包装。

**工具结果**（ToolResult）
`@mate/node-protocol` 里一次 node 工具调用的结局：纯文本内容加 `isError`。网关把它交给调用方；runtime 有自己的 `WorkspaceToolResult`，两者结构兼容，由 Agent Manager 在两边之间适配。

## 测试工具

**脚本化提供商**（ScriptedProvider）
`@mate/testkit` 里扮演模型提供商的本地 HTTP 服务，按真实协议返回 SSE。测试写好命名步骤，每个请求取走下一个步骤；脚本外的请求以不可重试的错误结束，并在 `assertComplete()` 里报出。

**lane**（ScriptedLane）
脚本化提供商里一个会话自己的步骤队列。请求按 `prompt_cache_key` 归到 lane：会话的第一个请求由声明了认领条件的 lane 认领，没人认领时归默认 lane。这样主对话和工作助手并发请求时，谁先到不影响脚本。
避免：用全局步骤顺序区分会话。
