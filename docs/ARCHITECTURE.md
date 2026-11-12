# Palace 架构

> 读者：只读过 `README.md` 的工程师。第一次出现的术语都会解释。

## 1. Palace 是什么

Palace 是几个人共用的小环境：每个人是一个人类账号，角色是管理员或普通人类。他们在里面和若干个持续存在的 AI Agent 同事一起工作。Agent 有稳定的身份，有一个跨频道、私信、讨论串一直延续的上下文，还有自己的工作目录。它能聊天、执行命令、读写文件、设提醒，并委派工作助手。

原名 Mate。产品展示和外部配置使用 Palace；登录 cookie、Durable 文档与任务的 `mate.*` 名称等已有存储标识保留。改名没有数据库迁移。

Agent 自己决定读什么、做什么、和谁协作、要不要发言。Palace 的职责是让这些选择都能做到，能被观察到，并且崩溃之后能接着做。

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
| `packages/chat`（`@palace/chat`） | 聊天 app |
| `packages/runtime`（`@palace/runtime`） | Agent runtime 及其扩展 |
| `packages/manager`（`@palace/manager`） | Agent Manager 和连接器 |
| `packages/node-protocol`（`@palace/node-protocol`） | 网关与 node 之间的消息格式，包括工具名和工具结果的形状 |
| `packages/clock`（`@palace/clock`） | 时钟：`now` 和可中止的 `sleep`，各模块共用，测试里换成可控时钟 |
| `packages/gateway`（`@palace/gateway`） | node 网关 |
| `packages/migrations`（`@palace/migrations`） | 迁移：一个存储的结构就是一串按版本递增的迁移（`Migrations`），聊天库和控制库都用它建表和升级 |
| `packages/control-store`（`@palace/control-store`） | 控制库：几个模块共用 `control.sqlite` 时，各自打开自己的表并按模块迁移结构版本 |
| `packages/admin`（`@palace/admin`） | 管理模块：Agent 的生命周期和设置、提供商的 API key、模型目录、node 配对、观察 Agent；它打开 Agent Manager，并把 node 网关接成工作区宿主 |
| `packages/testkit`（`@palace/testkit`） | 测试替身和工具，只给测试用 |
| `apps/control-plane`（`@palace/control-plane`） | Web 外壳后端和组装入口：登录、HTTP 路由、事件流、推送发送器、前端静态文件，`main.ts` 从环境变量启动 |
| `apps/web`（`@palace/web`） | Vite 网页客户端 |
| `apps/mobile`（`@palace/mobile`） | Expo 原生 iOS 客户端，包含认证、聊天、管理、Agent 观察、个人资料和原生通知 |
| `apps/node`（`@palace/node`） | node 进程和 `palace node` CLI |
| `tests/system`（`@palace/system-tests`） | 起真实控制面和 node 进程的系统场景（[tests/system/TESTS.md](../tests/system/TESTS.md)） |

## 4. 模块

这一节只说每个模块管什么、和谁相连。职责、接口、持久化和规则写在模块自己目录的 `ARCHITECTURE.md` 里，它测试什么写在同目录的 `TESTS.md` 里。改一个模块之前先读它的这两份文档。

| 模块 | 管什么 | 文档 |
| --- | --- | --- |
| 聊天 app | 账号、会话、时间线、已读位置、任务、收件事件、实时事件和推送队列。不知道 runtime 存在，Agent 在它眼里只是一种账号 | [packages/chat](../packages/chat/ARCHITECTURE.md) |
| Agent runtime | 一个 Agent 的 Durable Harness 和扩展：聊天、工作区、提醒、助手、历史、按需文档，以及后台命令 | [packages/runtime](../packages/runtime/ARCHITECTURE.md) |
| Agent Manager 和连接器 | 唯一能打开 runtime 的地方，每个 Agent 一条串行队列；连接器把收件事件变成 runtime 收件箱里的通知 | [packages/manager](../packages/manager/ARCHITECTURE.md) |
| Node 网关 | node 的配对、认证、心跳，把整个工具调用转发给 node | [packages/gateway](../packages/gateway/ARCHITECTURE.md) |
| Node | 宿主账号下的进程，在 Agent 的工作区里执行命令和文件工具；`palace node` CLI | [apps/node](../apps/node/ARCHITECTURE.md) |
| 管理模块 | 拥有 Agent Manager，管理 Agent、提供商凭据、node 授权、webhook、观察和工作区浏览 | [packages/admin](../packages/admin/ARCHITECTURE.md) |
| 控制面外壳 | 组装各模块，人类登录与管理、HTTP 路由、SSE、Web Push 和 APNs 发送器 | [apps/control-plane](../apps/control-plane/ARCHITECTURE.md) |
| 网页客户端 | 聊天和管理两个互不 import 的前端模块，共享外壳 | [apps/web](../apps/web/ARCHITECTURE.md) |
| 移动客户端 | Expo iOS app，覆盖聊天、管理、观察和原生通知 | [apps/mobile](../apps/mobile/ARCHITECTURE.md) |

接口用 Zod schema 定义，TypeScript 类型由它推导。各模块文档里的接口只描述形状和规则，签名以代码为准。

### 4.1 客户端之间共享什么

网页和移动端在同一个 pnpm workspace，共用根锁文件，面向同一个控制面。页面、导航、平台存储和通知集成各留在自己的 app 里。

- **契约只有一份。** 聊天的形状在 `@palace/chat/contracts`，登录与人类的形状在 `@palace/control-plane/contracts`，管理数据的类型从 `@palace/admin` 推导。这些入口不依赖 Node 或 SQLite，后端和两个客户端都从这里导入，不为移动端复制定义。
- **只在真的复用时才提取。** 两端都用的纯逻辑放在所属包的 `client` 入口：`@palace/chat/client` 有时间线键、条目合并、提及解析、发送后剩下的草稿和重连退避；`@palace/admin/client` 有观察归约、node 配对命令和 webhook 地址。两个客户端按 `palace-source` 条件从源码引用它们。文案由各端自己翻译。不预建空的共享包。
- `@palace/clock` 也提供不依赖 Node 的入口，客户端的重连和超时共用它。

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

### 5.7 访问别的 node

1. 管理员在 Agent 页给笔记本授权，授权按 Agent ID 和笔记本 node ID 写入控制库，在线时立即准备该 Agent 的工作区。离线时准备延后到首次在线调用。
2. Agent 用 `node_list` 查到笔记本名字，调用 `read({ node: "laptop", path: "notes.txt" })`。
3. runtime 分离目标和文件参数，管理模块现读授权，网关确认当前连接支持独立访问工作区后，把带 `access: "visit"` 的调用交给笔记本。
4. node 确保 `<工作区根>/<agentId>` 存在，在其中读取文件并返回结果。重复准备不改已有文件。
5. 管理员收回授权后，下一次访问被拒绝；此前已经发出的调用仍然完成。

## 6. 数据布局

```
data/
  control.sqlite              控制库：人类和登录会话、VAPID 密钥、API key、node 注册表和授权、webhook（0600）
  chat.sqlite                 聊天 app 的全部数据，含头像、推送订阅和推送队列
  attachments/                附件文件（还没有实现）
  agents/<agentId>.sqlite     每个 Agent 的 Durable 存储，含配置、提醒和连接器位置
```

搬到另一台机器：停掉容器，复制 `data/`，启动。

**结构迁移。** 每个存储的结构就是一串按版本递增的迁移（`@palace/migrations` 的 `Migrations`），没有另一份"当前建表语句"。新存储跑完整个列表，已有存储只跑比它的版本新的迁移，所以新建的和升级来的结构不会分叉。启动时在一个事务里迁移，失败就回滚，存储留在旧版本并拒绝启动。存储比代码新，或停在列表里没有的版本，同样拒绝启动，不改动文件。迁移时外键关闭以便重建表，提交前用 `foreign_key_check` 确认没有悬空引用。

升级是否可行由存储夹具证明：`scripts/make-store-fixture.ts` 从已发布的版本生成真实的数据目录，放在 `tests/fixtures/stores/<版本>/`，测试在它的副本上启动新代码。API 变了的版本要有自己的填充脚本 `scripts/store-fixture/populate-<版本>.ts`。

**控制库由几个模块共用。** 外壳、网关和管理模块各用 `@palace/control-store` 的 `openControlTables(dataDirectory, { module, migrations })` 打开自己的一条连接，只建、只检查自己的表。

- 结构版本记在 `schema_versions` 表里，每个模块一行。一个模块的版本不兼容时，只有这个模块拒绝启动（`ControlStoreIncompatible`），别的模块照常打开。
- 第一条迁移用不带 `IF NOT EXISTS` 的 `CREATE TABLE`，所以两个模块的表名撞了会拒绝启动，不会悄悄共用一张表。
- 文件由 `openControlTables` 以 0600 新建，已有文件不改权限。
- 每条连接用 WAL、`synchronous=FULL` 和 5 秒 busy timeout。`node:sqlite` 是同步的，不 await 的事务在别的连接开始事务之前就已结束，所以规则是控制库的事务里不 await。busy timeout 只给进程外的读写者（备份、`sqlite3` 命令行）留余地。

## 7. 部署

控制面是一个 Docker 镜像，以一个专用的无登录系统账号运行，数据目录只属于它。node 以宿主现有账号运行，读不到模型凭据和对话库，也不在 docker 组里。node 发布包自带 Node 运行时，Linux x64、macOS arm64 和 Windows x64 各一个。

Palace 不创建用户、不切换身份、不安装系统软件、不配置 linger。Agent 在命令里写的 `sudo` 能否成功由宿主的 sudo 策略决定。安装、更新和自动部署见 [DEPLOYMENT.md](DEPLOYMENT.md)。

## 8. 测试策略

只在模块边界测试，不写单元测试。每个模块从它对外的接口驱动，边界外的依赖用替身：脚本化的模型提供商（跑在真实 HTTP/SSE 上）、假的 node 连接、可控时钟和临时文件。失败和恢复路径与正常路径同样重要：在指定的提交点之前或之后崩溃，再重启。

共用的规则和替身在 [MODULE_TESTS.md](MODULE_TESTS.md)，每个模块具体测什么在它目录的 `TESTS.md` 里。

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
- 不做逐条命令审批，不做 Palace 自己的提权。
- 不限制 Agent 读同事的工作区，只在提示里请它不要读。
- 不使用 `pi-coding-agent`。
- 几个人共用，每人自己的登录；角色只有管理员和普通人类两种（管理员管理 Agent、提供商和 API key、node 和其他人类，普通人类只聊天）；网页中英双语并适配手机，原生移动端根据设备偏好显示简体中文或英文。
- 规模很小：几个人，少量 Agent（模型费用决定了不会多），消息量不大。不为数据量做性能优化或分页之类的设计，除非测量证明确实有问题；结构简单优先。
