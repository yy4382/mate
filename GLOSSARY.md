# 术语表

本项目在文档、代码和对话里统一使用下面这些词。每个词后面括号里是代码中使用的英文名。「避免」列出容易混淆、不应该用来指代这个概念的说法。

## 人与 Agent

**管理员**（admin）
角色为 `admin` 的人类：除了聊天，还能创建和配置 Agent、管理提供商和 API key、配对 node，以及添加、改角色、重置密码和停用其他人类。第一个人类是管理员，任何时候至少有一个有效的管理员（最后一个不能被降级或停用，回 409 `last-admin`）。普通人类调用这些操作回 403 `admin-only`。
避免：所有者（Mate 里不止一个人；每个人类在聊天里是平等的账号，只有角色不同）。

**角色**（role）
Web 外壳记在 `humans` 表里的人类权限：`admin` 或 `member`。`member` 是普通人类，只聊天，并能改自己的显示名、handle 和密码。角色不在聊天账号上：聊天 app 不知道角色，每个人类账号读到的内容一样。
界面上 `admin` 叫"管理员"，`member` 叫"普通人类"。
避免：把普通人类叫"成员"（成员指会话的成员）。

**人类**（human）
账号的一种（`kind: "human"`）：能读所有会话，有实时视图和推送订阅，不由 Agent 管理器管理。可以有多个，各有各的登录（handle 加密码）、已读位置、未读摘要和推送订阅。另一种是 Agent 账号（`kind: "agent"`）。账号的种类创建时定下，之后不能改。
避免：用户、成员（成员指会话的成员）。

**Agent**（agent）
一个长期存在的 AI 同事。它有稳定的 Agent ID、一个聊天账号、各 node 上独立的工作区和一个 runtime。一次模型调用、一次 run 或一个工作助手，都不是新的 Agent。

**Agent ID**（agentId）
创建 Agent 时生成的唯一标识，之后永不改变。它同时用作 Agent 存储文件的文件名，以及 Agent 聊天账号的 `externalId`。
避免：名字、handle（它们可以改）。

**头像**（avatar）
Agent 的头像由它的聊天账号 ID 生成，人类的头像是名字的首字母。
避免：用名字或 handle 生成（它们可以改）。

## 聊天 app

**聊天 app**（chat）
Mate 内置的类 Slack 聊天系统。它不知道 runtime 和模型的存在。

**账号**（account）
人类或 Agent 在聊天 app 里的身份，种类是 `human` 或 `agent`。

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

**关注**（follow）
账号关注的时间线：它是成员的会话的顶层，以及它能读、并且是根消息作者、回复过或被 @ 过的讨论串。新消息只通知关注这条时间线的人；未读摘要列的也正是关注的时间线。
避免：订阅、participant（只说了一半）。

**账号视角**（AccountChat）
`ChatApp.forAccount(account)` 返回的对象：一组绑定到这个账号的读写方法，参数与 `ChatApp` 相同、去掉 account。它在结构上满足 runtime 的聊天端口。

**未读摘要**（unread summary）
某个账号当前各条时间线的未读数量，以及其中有没有 @ 自己的消息。每条时间线还带上会话类型、显示名（频道名；私信为对方的 handle）、是否讨论串和最新一条未读的发送者，足够直接渲染一条通知。

**收件信号**（inbox signal）
聊天 app 在一次写操作提交、并且这次写追加了收件事件之后发出的提醒，只带收到事件的账号，不带事件本身。它只是"该去读收件事件了"的提示，连接器仍然从自己的事件位置往后读，所以错过一次信号不会丢事件。

**实时事件**（live event）
人类账号的浏览器实时显示聊天所依靠的一条记录：一个新条目、一个会话或成员的变化、一个账号的变化，或者某个人类账号已读位置的前进。由 `chat.sqlite` 里的触发器在改动事实的同一个事务里追加，保留一天。只有人类账号能读；带受众：空表示每个人类账号都看到，已读位置只给前进的那个人类账号。
避免：收件事件（那是给连接器的、按账号写的通知记录）。

**实时快照**（live snapshot）
人类账号的客户端打开时需要的全部状态：自己是哪个账号（`me`）、账号、会话、未读摘要，可选再加一条时间线的最新一页，连同对应的实时游标，在一次读取里得到。

**实时游标**（live cursor）
客户端在实时事件里的位置：由纪元和事件 ID 组成的不透明字符串，可以直接当 SSE 的事件 ID 用。
避免：游标（那是 runtime 存在 Durable 里的命名位置）。

**纪元**（epoch）
新建 `chat.sqlite` 时随机生成、之后不变的 ID，写在每个实时游标里。数据重置后纪元不同，旧游标因此作废。

**需要重新拉快照**（resnapshot）
`liveEvents` 对一个无法接着读的游标的回答：纪元不同、早于保留的事件、超前于库里最新的事件，或者根本不是游标。客户端收到后重新取实时快照。

**推送订阅**（push subscription）
某个人类账号的一个浏览器的 Web Push 订阅：endpoint 加 `p256dh`、`auth` 两个密钥，连同订阅它的账号，存在 `chat.sqlite` 里，以 endpoint 为键。推送只推给订阅所属账号自己的通知；另一个人类账号再订阅同一个 endpoint，订阅就归到它名下。

**推送队列**（push queue）
还没送达的推送，每条是"一条消息推给一个推送订阅"。在消息提交的同一个事务里追加，由聊天 app 的投递循环按到期时间投递；暂时失败时等待翻倍后重试，重启后照原计划继续。

**推送内容**（PushNotice）
一次推送带的东西：定位和显示一条消息所需的信息（会话、时间线、序号、发送者、发送时间等），不含正文。同一条消息的每次投递 `tag` 相同。

**推送发送器**（PushSender）
调用方交给聊天 app 的端口：把一份推送内容发给一个推送订阅，返回推送服务的 HTTP 状态码，连不上时抛错。Web 外壳用 VAPID 密钥实现它。

**requestId**
调用方为一次操作生成的稳定 ID。接收方按它去重：同一个 ID 只生效一次，重复调用返回第一次的结果。Agent 的聊天工具调用用 Durable 的工具调用 ID 作为 requestId；人类的网页请求由浏览器生成。node 工具调用没有调用方的 requestId：网关为每次调用生成自己的请求 ID，只用来对应输出、结果和停止。

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
Agent 派生出来的另一个 Durable 对话，有自己的上下文。它和主对话共享模型设置、凭据和工作区，没有聊天工具，完成后向派生它的对话汇报。进入它的输入都经过投递，所以它的每个回答都汇报给主对话。它不是新的 Agent。

**投递**（delivery）
把一条输入交给这个 Agent 的某个对话的 Durable 后台任务，跑在主对话里。目标是工作助手时，它等助手回答，再把回答作为助手汇报提交给主对话，恰好一次。进入助手对话的输入只走这一条路：主对话发给助手的消息、助手自己的后台命令汇报都是投递。

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
runtime 自己定义的、绑定到 Agent 账号的聊天操作接口，聊天工具只通过它调用聊天 app。Agent Manager 用 `ChatApp.forAccount` 得到的账号视角实现它。runtime 不 import 聊天 app。

**游标**（cursor）
runtime 存在自己 Durable 存储里的一个命名位置，只进不退，比如连接器在收件事件里处理到的事件 ID（`chat-inbox`）。

**提醒**（reminder）
Agent 给自己设定的定时输入，保存在它自己的存储文件里，到时间后提交到主对话的收件箱。

**压缩**（compaction）
Durable 在上下文快满时，向对话自己的模型发一次**摘要请求**（summary request），把较早的记录写成摘要，模型之后只看到摘要和最近的记录。摘要请求不带工具，也不带 `prompt_cache_key`；它失败或被截断时摘要不生效。被压缩掉的记录仍在存储里，Agent 用历史工具读它们。

**历史记录**（history record）
一个对话存下的一条输入、模型的一次回答（含工具调用）或一个工具结果，按存入顺序从 1 编号，编号永不改变。系统提示的变化、压缩摘要，以及历史工具自己的调用和结果不算。历史工具 `history_search` 和 `history_read` 按编号搜索和阅读一个对话自己的历史记录，包括已被压缩出上下文的；结果里的 `inContextFrom` 是还在上下文里的第一条。
避免：条目（那是聊天 app 时间线上的项）。

**后台命令**（background command）
`bash` 带 `background: true` 启动的命令。工具调用立即返回一个命令 ID，也就是 runtime 为它在发起它的对话里建的 Durable 后台任务的 ID；命令在 node 上继续跑，对话照常工作、照常空闲。结束时它的结果经投递作为一条输入（`command:<ID>`）提交给发起它的对话，恰好一次。用 `bash_stop` 停止，停止后不再汇报。runtime 关闭时它和前台命令一样被停掉，重新打开后汇报一次"已中断"，不会重跑。
避免：后台进程（命令自己放到后台的进程，比如 `cmd &`，仍归命令进程组管）；守护进程（Agent 用 `setsid` 等方式自己脱离进程组的进程，Mate 不跟踪）。

## 环境与控制面

**控制面**（control plane）
运行在 Docker 容器里的单个进程，包含 Web 外壳、聊天 app、管理模块、Agent Manager、所有 runtime 和 node 网关。

**控制库**（control store）
`data/control.sqlite`：网关的 node 注册表、Web 外壳的登录、管理模块的 API key 和 node 授权共用的一个 SQLite 文件。每个模块用 `@mate/control-store` 的 `openControlTables` 打开自己的一条连接，只建、只检查自己的表；`schema_versions` 表里每个模块一行结构版本，一个模块版本不对只让这个模块拒绝启动。
避免：说某个模块"拥有" `control.sqlite`；用 `PRAGMA user_version` 记控制库的版本（一个文件只有一个）。

**Web 外壳**（shell）
负责人类的登录和管理、HTTP 路由，以及把聊天和管理两个前端功能区挂在同一个网页里。后端在 `apps/control-plane`：`startControlPlane` 组装聊天 app、网关和管理模块，挂在一个 HTTP 服务器上；它在控制库里的模块名是 `shell`。

**前端**（web client）
`apps/web` 的网页应用，登录页在 `/login`，其余页面在 `/app` 下。里面是聊天和管理两个互不 import 的功能区，只共享外壳的登录状态、导航和布局。服务端数据都放在 TanStack Query 的缓存里。
避免：把它叫"Web 外壳"（外壳是后端 `apps/control-plane` 加上前端挂载的那一层）。

**密码校验队列**
登录里同时进行的 scrypt 校验最多 2 个，更多的按到达顺序排队（队列最长 64，排队最多 10 秒），超出的回 429；没有锁定，所以输错再多次，正确的密码也进得来。

**登录会话**（Session）
一个人类用 handle 和密码登录一次得到的会话：一个随机令牌放在 HttpOnly cookie 里，控制库只存它的 SHA-256，并记着它属于哪个人类。从登录起 30 天有效，退出登录立即失效，跨重启保留；这个人类被停用、被管理员改了角色或重置密码，或自己改了密码（改密码的那个会话除外）时结束：会话是登录时那一刻的权限快照，权限变了就重新登录。
避免：会话（那是频道或私信）、session 指代聊天里的东西。

**初始密码文件**（initial password file）
第一次启动时第一个管理员密码的来源。控制库里还没有任何人类时读一次，只存 scrypt 哈希，之后不再读；第一次启动没有它就拒绝启动。

**初始 handle**（initial handle）
第一个管理员的 handle，也是其初始显示名：环境变量 `MATE_INITIAL_HANDLE`，缺省 `admin`，要符合聊天账号的 handle 规则。只在第一次启动时用，之后可以自己改名。

**人类名册**（Humans）
Web 外壳里管理谁能登录的类（`apps/control-plane/src/humans.ts`）：人类的角色、密码哈希、是否有效，以及登录会话。它和聊天 app 靠聊天账号的 externalId 对上：名字和账号种类归聊天 app，登录和角色归外壳。

**事件流**（EventStream）
Web 外壳发给浏览器的一条 SSE 连接：人类自己的实时事件流（`/api/chat/events`，SSE id 就是实时游标），或观察一个 Agent 的 agent 事件流。它只活在登录会话期间：会话结束后发 `login` 并关闭，不再发别的。
避免：把它和实时事件本身混为一谈（事件是聊天 app 的日志，事件流只是把日志送出去的连接）。

**VAPID 密钥**（VapidKeys）
Web 外壳签名推送请求用的 P-256 密钥对，第一次启动时生成，存在控制库里，之后不变。浏览器用它的公钥订阅推送，所以换密钥会让所有订阅失效。

**管理模块**（admin）
管理员用来创建和配置 Agent、管理 API key、配对 node、查看对话记录和用量、浏览工作区的模块。它拥有 Agent Manager：`openAdmin` 打开 Manager，并把 node 网关接成 Manager 的工作区宿主，Web 外壳不直接碰 Manager。

**提供商**（provider）
模型的提供方，在 pi-ai 模型目录里有一个 ID。只提供 `openai`（Responses API）和 `deepseek`。

**模型目录**（model catalog）
pi-ai 自带的模型清单（`builtinModels()`）。每个模型带它接受的 thinking 级别；runtime 的 `catalogModels(provider)` 列出一个提供商的模型，Agent 的请求也在这个目录里解析。
避免：自己写一份模型或 thinking 级别的列表。

**凭据**（ProviderCredentials）
一个提供商的 `{ apiKey, baseUrl? }`，存在控制库里管理模块的表中，是唯一一份。runtime 每次模型请求都按提供商现读（`credentials(provider)`），所以改了从下一次请求起生效；`baseUrl` 替换模型目录里这个提供商的地址。没有凭据的提供商，请求不发出就失败。
避免：把 key 复制进 Agent 文件或 runtime 的内存。

**agent 事件**（AgentEvent）
Durable 从一个对话的提交推出来的观察事件：快照、流式文字、工具调用的开始、输出和结束、输入、用量。runtime 的 `watchEvents` 和管理模块的 `watchAgent` 原样交出它们；观察只读，不改变 Agent 的状态。
避免：transcript 文件、日志（Mate 不另存对话记录）。

**Agent Manager**（manager）
唯一能打开和关闭 runtime 的模块。一个 Agent 存在，当且仅当它的存储文件存在。

**暂停**（pause）
关闭一个 Agent 的 runtime，并在它的存储文件里记下"已暂停"。恢复就是清除这个记录，重新打开 runtime。Agent 只有打开和关闭两种状态；"已暂停"只是关闭的 Agent 留在文件里的记录，让它重启后仍然关闭，只在 Agent 关闭时读写。runtime 因存储出错死掉时，Agent 变为关闭，但没有这条记录。
避免：把"已暂停"当成和打开的 runtime 并存的标记。

**连接器**（connector）
把一个 Agent 账号的收件事件变成它 runtime 收件箱里一条通知的组件。

**通知**（notice）
连接器提交给 runtime 的一条不含消息正文的提示，写明截至某个时间点至少有多少未读、分布在哪里、有没有 @ 你。同一时间最多只有一条还没交给模型的通知，新的会替换旧的。

**node**
以宿主机上一个普通账号（node 账号，不是控制面的账号，也不在 docker 组里）运行的执行进程，由 `mate node` CLI 管理：Linux 是 systemd 用户服务，macOS 是 LaunchAgent，Windows 是当前账号登录时启动的计划任务。它在该 node 上的 Agent 工作区里执行命令、读写文件，不接触模型凭据和对话记录。

**平台表**（platform table）
node 根据当前系统选择能力的唯一入口。Linux、macOS、Windows 各有一条记录，提供 shell、命令进程组、服务、布局、启动命令、身份权限检查和工作区路径规则。共同的安装流程、超时和输出处理不随平台复制。

**主 node**（home node）
Agent 创建时选定的 node，ID 记在 Agent 文件里且不变。缺省工具调用在这里执行，主工作区中的 MEMORY.md 是记忆入口约定；经授权的其他 node 也各有独立执行目录。

**访问**（visit）
Agent 把一次工具调用送到已授权的非主 node，在该 node 上自己的工作区里执行。

**访问方式**（NodeAccess）
管理模块判断的主 node 或访问关系，主 node 为 `home`，获准访问的非主 node 为 `visit`，经网关交给 node。两者使用相同的 Agent 工作区路径，但主工作区只显式初始化，访问工作区的准备不初始化 MEMORY.md。

**node 授权**（node grant）
管理员允许某个 Agent 访问一个非主 node 的记录，按两个 ID 存在控制库。主 node 不需要授权；授权先持久化，在线时准备工作区，离线时延后到首次在线调用。授权和收回只影响之后开始的调用，收回不删除工作区。

**node 名字**（node name）
网关保存的、管理员可改且唯一的机器名字；UUID 仍用于身份和调用（[ARCHITECTURE §4.5](docs/ARCHITECTURE.md#45-node-网关与-node)）。

**系统信息**（NodeSystem）
node 在握手时报告的宿主平台、架构、hostname、系统版本和程序版本，由网关保存最近一份（[ARCHITECTURE §4.5](docs/ARCHITECTURE.md#45-node-网关与-node)）。

**链路**（link）
`node run` 与网关之间的连接是否已经握手成功。node 在数据目录的 `link.json` 里记下 `{ pid, connected, since }`（握手成功或连接结束时原子替换；启动时先写 `connected: false`）。`mate node status` 的 `Link:` 行只在服务正在运行、且能确认文件属于它的执行进程时读它，否则是 `Link: none`。Linux 核对 systemd 的 MainPID，macOS 核对 launchctl 的 PID，Windows 核对任务实例与进程路径、创建时间，所以崩溃进程留下的文件不会被当成已连接。自动部署用 `Link: connected` 判断新 node 起好了。
避免：把服务正在运行叫连上（服务管理器只知道进程在跑）。

**发布包**（bundle）
node 的发布产物：一个 gzip 压缩的 ustar 归档，里面只有 `mate-node/` 一个目录（Node 运行时、打成一个脚本的 node 程序和 CLI、`mate` 启动命令、清单），旁边是它的 `.sha256`。由 `pnpm bundle:node` 构建，`mate node install`/`update` 读取。Linux、macOS、Windows 各有 x64/arm64 包；文件名分别用 linux、darwin、win，清单的 Windows 平台值为 win32。
避免：安装包、release（指 GitHub 的发布页时才用）。

**自动部署**（deploy）
推送 `v*` 标签发版之后，CI 的 Deploy 任务只针对 Linux 的同机部署，经一把只能执行 `mate-deploy` 的 SSH key，把同机部署的控制面和 node 升级到这个版本；先备份数据目录，失败就回退到原版本和这份备份（DEPLOYMENT 5.5）。
避免：把推到 main 叫部署（只有发版才部署）。

**清单**（manifest）
发布包和程序目录里的 `manifest.json`：版本、平台、架构，以及其余每个文件的路径。它同时是"程序目录里哪些文件属于 Mate"的唯一依据。

**程序目录**（program directory）
POSIX 上是 `~/.local/lib/mate-node`，Windows 上是 `%LOCALAPPDATA%\Mate\program`，保存解开的发布包。只会被整个放入（暂存目录改名）或整个挪走，从不原地修改，所以要么是完整的某个版本，要么不存在。配置、node 身份和工作区都在它之外。

**工作区宿主**（WorkspaceHost）
Agent Manager 看到的"工作区在哪里"：在主 node 上为一个 Agent 准备工作区（`prepare(nodeId, agentId)`，可以重复调用），以及给出以这个主 node 为缺省目标的工作区端口（`port(nodeId, agentId)`）。Agent 的主 node 在创建时选定，记在它的文件里，之后不变；Manager 打开 Agent 时从文件读出它。node 网关本身不实现它（`NodeGateway` 没有 `port()`），由管理模块把网关适配成它：创建 Agent 时以 `home`、在线授权时以 `visit` 调 `prepareWorkspace`，端口按调用的可选 node 名字和最新授权选择目标，连同访问方式转给 `runTool` 并带上调用的 signal；`nodes()` 列出当前可访问的 node。Manager 的测试里用假的。

**node 网关**（node gateway）
控制面里负责 node 配对、认证、心跳，并把工具调用整个转发给 node 的模块。

**网关操作拒绝**（NodeGatewayError）
`@mate/gateway` 对 node 操作的拒绝异常，带 `reason`，与线路上的 `gateway.error` 消息不同（[ARCHITECTURE §4.5](docs/ARCHITECTURE.md#45-node-网关与-node)）。

**工作区**（workspace）
Agent 在某个 node 上的工作目录，路径为该 node 的 `<工作区根>/<agentId>`。每个已授权 node 上各有独立工作区，文件不跨 node 同步。主工作区在创建 Agent 时初始化目录与 MEMORY.md，执行时缺少目录就报错；访问工作区在授权或首次在线调用时准备，不初始化 MEMORY.md，已有文件保持原样。

**命令进程组**（command process group）
node 对一条 `bash` 命令所启动进程的把手：POSIX 进程组或 Windows 活 shell 的进程树，追踪与停止的范围见 [ARCHITECTURE §4.5](docs/ARCHITECTURE.md#45-node-网关与-node)。

**身份拒绝**（gateway.refused）
网关对 node 说"你是谁"不被接受：身份不认识（`unknown_identity`）、签名或公钥无效、配对令牌被拒。除了"不认识"而 node 手里有配对令牌的情况，node 收到后退出，不重试。
避免：把它和**协议错误**（`gateway.error`：格式错误、顺序错误、握手超时、内部错误）混为一谈；协议错误只结束这条连接，node 退避重连。

**已停止**（stopped）
调用方中止一次 node 工具调用后得到的结果：网关已让 node 杀掉这次调用的命令进程组，已经做了的不会撤回，也不会重做。
避免：结果未知（那是连接断开时的结果）。

**工作区环境**（WorkspaceEnv）
node 上限定在一个根目录里的 Durable `NodeExecutionEnv`：Durable 的 `read`、`write`、`edit` 在它上面执行，浏览工作区也用它；所有调用的根都是目标 node 上的 Agent 工作区。每个路径先经过它解析，`..`、指向外部的绝对路径和符号链接都在这里被拒绝。Windows 同时处理盘符、反斜线和大小写，允许根目录自身的别名，拒绝经过根以下的符号链接或 junction；POSIX 保留指向该根目录内部的链接。

**浏览工作区**（browse）
管理员在管理界面里只读地看 Agent 工作区里的一个路径：管理模块的 `browseWorkspace` 调网关的 `browse`，网关发 `gateway.browse`，node 回 `node.browse.result`。回答是一个**浏览结果**（`WorkspaceListing`：目录的条目、文件开头的文字，或者不是文字的文件的大小，各有上限并标明截断），或者一个拒绝（`outside-workspace`、`not-found`、`unreadable`，网关再加上 `node-offline`）。不经过 runtime，暂停的 Agent 也能看。
避免：把它当成工具调用（它不是 `runTool`，没有输出流，也没有停止）。

**部署冒烟**（deploy smoke）
`pnpm smoke:deploy`：在 Docker 里用发布的镜像、Compose 文件和 node 发布包起一套控制面加 node，并以第一个管理员的身份走一遍登录、配对、创建 Agent、私信回复和重启（MODULE_TESTS 第 13 节）。

**MEMORY.md**
主工作区里的记忆入口约定，由 Agent 自己维护和选择读取。Mate 只在显式准备主工作区时创建缺失的空文件，执行工具不检查它，runtime 恢复也不自动读取它。远端工作区不预置这个文件。

## 共用基础

**时钟**（clock）
`@mate/clock` 里的 `Clock`：读当前时间（`now`），以及睡到某个时长或某个 `AbortSignal` 中止为止（`sleep`）。所有需要时间或定时器的模块都通过它，而不是直接调用 `Date.now` 或 `setTimeout`；一个定时器就是一次带自己 signal 的 `sleep`，中止 signal 就是取消它。测试里换成**可控时钟**（`FakeClock`），由测试推进时间。
避免：timer handle、setTimeout 包装。

**工具结果**（ToolResult）
`@mate/node-protocol` 里一次 node 工具调用的结局：纯文本内容加 `isError`。网关把它交给调用方；runtime 有自己的 `WorkspaceToolResult`，两者结构兼容，管理模块把网关接成工作区宿主时直接交过去。

**迁移**（migration）
`@mate/migrations` 里的 `Migration`：一个版本号加把存储带到这个版本的 SQL。一个存储的结构就是一份 `Migrations`，即版本严格递增的迁移列表；新存储跑完整个列表，已有的存储只跑比它的版本新的迁移，所以没有单独的"当前建表语句"。聊天库、控制库里每个模块的表都这样管理。存储比列表的最新版本新、或停在列表里没有的版本，拒绝启动。
避免：为某一种旧状态写的临时修补代码（迁移只能是列表里的一项）。

## 测试工具

**脚本化提供商**（ScriptedProvider）
`@mate/testkit` 里扮演模型提供商的本地 HTTP 服务，按真实协议返回 SSE。测试写好命名步骤，每个请求取走下一个步骤；脚本外的请求以不可重试的错误结束，并在 `assertComplete()` 里报出。

**lane**（ScriptedLane）
脚本化提供商里一个会话自己的步骤队列。请求按 `prompt_cache_key` 归到 lane：会话的第一个请求由声明了认领条件的 lane 认领，没人认领时归默认 lane。这样主对话和工作助手并发请求时，谁先到不影响脚本。不带 `prompt_cache_key` 的请求（摘要请求）不属于任何会话：每个都由一个还没绑定会话的 lane 单独认领，认领后这个 lane 仍能认领下一个。
避免：用全局步骤顺序区分会话。

**假推送服务**（FakePushService）
聊天 app 测试里的推送发送器：记录每次请求和到达的时间，按测试给每个 endpoint 写好的回答返回状态码或"连不上"，之后都回 201。

**网络代理**（NetworkProxy）
`@mate/testkit` 里夹在 node 和网关之间的本地 TCP 代理，由测试切换三种模式：转发（`forward`）、黑洞（`blackhole`，连接不断但两个方向的数据都被吞掉）、断开（`disconnect`，断掉现有连接，新连接一到就断）。

**人类浏览器**（HumanBrowser）
`@mate/testkit` 里扮演某个人类的浏览器的 HTTP 客户端：用 handle 和密码登录（`logIn(handle, password)`），保存服务器设的会话 cookie，请求体按 JSON 发，可以打开 SSE 事件流（`EventReader`）。控制面的测试和系统场景共用它。

**系统场景**（system scenario）
`tests/system` 里的端到端测试：控制面和 node 以真实子进程启动（**进程夹具**），模型是脚本化提供商，管理员的操作经 HTTP 发出。只证明模块接在了一起，边界情况归各模块的测试。
避免：集成测试（那个词留给用真实提供商或真实 VPS 的检查）。

**存储夹具**（store fixture）
`tests/fixtures/stores/<版本>/` 下由 `scripts/make-store-fixture.ts` 从某个已发布的版本生成的真实数据目录（`control.sqlite`、`chat.sqlite`、真实 Agent 文件），测试在它的副本上用新代码启动，证明升级后数据还在。夹具只用旧版本模块的公开接口写出，不手写旧表。
避免：手工拼出来的旧结构 SQL（那证明不了真实的旧存储能升级）。

**进程夹具**
`tests/system/test/support.ts` 的 `startSystem()`：在临时目录里启动控制面（`main.ts`）、用配对令牌配对的 node（`mate node run`，HOME 是临时目录）和脚本化提供商；控制面能被 SIGKILL，并在同一个数据目录和同一个端口上重启，node 可以经网络代理连到控制面。`addNode()` 可再配对一个有独立主目录和身份的 node，通过新出现的在线 ID 确认连接。
