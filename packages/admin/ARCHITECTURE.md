# 管理模块（`@palace/admin`）

> 总览见 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)。测试见 [TESTS.md](TESTS.md)。

## 职责

管理员用来管理 Agent 和环境：

- 创建、删除、暂停、恢复 Agent，设置模型、thinking 级别和说明文字；
- 管理提供商的 API key；
- 配对 node、改名、查看在线状态和系统信息，为 Agent 授权或收回其他 node；
- 观察 Agent 的实时对话和工具调用，查看用量，浏览工作区；
- 管理 Agent 的入站 webhook。

管理模块不管聊天。Agent 的显示名和 handle 属于聊天账号，管理模块从 `chat.listAccounts()` 读，不另存。

## 它拥有 Agent Manager

`openAdmin` 先打开自己在控制库里的表，再打开 `data/agents/` 上的 Manager。管理模块把网关适配成 Manager 的工作区宿主：创建 Agent 时准备主 node 工作区，授权时准备目标 node 工作区，工作区端口为每次调用检查授权、选择目标后转给 `runTool`。凭据查找读自己的凭据表。所以 Web 外壳只组装聊天 app、网关和管理模块，不直接碰 Manager。

## 接口

给 Web 外壳的 `/api/admin/*` 用，签名在 `src/index.ts`。操作分 Agent（列出、创建、暂停、恢复、删除、设置、授权、观察、浏览）、提供商与模型、webhook 和 node（转给网关）几组。`agents()` 把读不出的 Agent 以 `unreadable` 列出，管理员可以删掉它。`close()` 关闭 Manager 和自己的连接，网关和聊天 app 由外壳关闭。

拒绝都是带 `reason` 的 `AdminError`，被拒绝的操作什么都不改。例外是创建时聊天 app 的拒绝（`handle-taken`、`inactive-account`），以 `ChatError` 原样出来，因为那时什么都还没创建。对 Agent 的操作排在该 Agent 的队列里，排队期间 Agent 被删除也得到 `unknown-agent`。

## node 授权

工作区端口接受 `{ tool, arguments, node?, conversationId }`。runtime 从工具参数里取出 `node`，node 收到的 `arguments` 不变。缺省目标是主 node，否则按名字解析。

只有 `nodeAccess(agentId, homeNodeId, targetNodeId)` 决定访问方式：主 node 返回 `home`，授权表里有的返回 `visit`，其余拒绝。工具调用和 `nodes()` 共用它，以后增加权限规则只改它和它读的数据。未知名字和未授权名字返回相同错误，列出可访问的名字，不向 node 发请求，也不泄露其他 node 是否存在。授权按 ID 保存，改名后仍有效。

授权先持久化，再等在线 node 准备工作区。离线时授权照样成功，首次在线调用时由 node 准备。在线准备失败经 `report` 报告，授权保留。准备期间收回授权，迟到的准备结果不会恢复它；收回不删除工作区。授权和收回只影响之后开始的调用。主 node 不能授权或收回。删除 Agent 后清理它的授权，残留行无害，因为 Agent ID 不会复用。

## 模型和 API key

模型来自 pi-ai 自带的目录（runtime 的 `catalogModels`），管理界面提供 OpenAI（Responses API）和 DeepSeek。凭据按提供商存 `{ apiKey, baseUrl? }`，`baseUrl` 替换这个提供商所有模型的地址。设置模型时（包括创建 Agent 时，在任何东西创建之前）检查提供商、已存 key、模型在目录里、thinking 级别被这个模型接受，不接受就拒绝，不降级。runtime 每次请求现读凭据，所以改 key 从下一次请求生效，删 key 后这个提供商的请求不发出就失败。

## 入站 webhook

外部系统（CI、监控、别的 bot）把一条消息直接交给某个 Agent 并唤醒它。它不是聊天消息，不经过聊天 app，人类看不到也不推送，管理员在观察界面看到。`deliverWebhook` 对打开的 Agent 调 `runtime.submit(content, { requestId, whenBusy: "steer" })`，和连接器、提醒是同一个入口。

Durable 的输入不带元数据，所以发送者写进内容：

```
<external_webhook_content webhook="<name>" id="<webhookId>" at="2026-11-11 14:32:05 UTC">
<text>
</external_webhook_content>
```

标签和转义只由 runtime 的 `renderWebhookContent` 写。名字和正文里的 `&`、`<`、`>` 都转义（属性里再转义引号和控制字符），所以外部内容关不掉标签，也加不进属性。名字由管理员设定，可信；正文的权威不超过管理员给这个 webhook 的。系统提示只有一段说明标签的含义，接口细节在按需文档里。

- **幂等。** `requestId` 是 `webhook:<webhookId>:<Idempotency-Key>`，没有 key 时用随机 UUID。同一个 key 只有第一次生效，key 不过期。
- **密钥。** 32 字节随机数的 base64url，只在创建和轮换时返回一次，库里只存 SHA-256，用 `timingSafeEqual` 比较。未知 webhook、错误密钥和 Agent 已删除的 webhook 都回 `invalid-webhook`；未知 ID 也对占位哈希做同样的比较，所以响应时间不泄露 ID 是否存在。
- **大小。** `text` 1 字节到 32 KiB。路由的请求体上限是 32 KiB 的 6 倍加 1 KiB，因为 JSON 最多把一个字节写成 6 字节，合法的文字一定放得下。请求体形状在密钥通过之后才检查。
- **Agent 关闭时**回 `agent-closed`，不排队。和删除 Agent 并发时，结果取决于谁先，每种结果都不留下任何东西。删除 Agent 后一并删除它的 webhook。

## 观察和浏览

`watchAgent` 就是 runtime 的 `watchEvents`：第一批是快照，之后是流式文字、工具调用和输出、输入、用量。只读，关闭的 Agent 回 `agent-closed`。

`browseWorkspace` 按 Agent 文件里的 node ID 调网关的 `browse`，不经过 runtime，所以暂停的 Agent 也能看。node 用和文件工具相同的工作区环境解析路径，越出工作区的路径、外指或悬空的符号链接都回 `outside-workspace`。node 只读：目录按名字排序列出条目，文件给出大小和开头的文字，二进制文件只给大小。文件最多 128 KiB、目录最多 500 条，超出时标明 `truncated`，这两个上限保证任何回答都在网关 1 MiB 的帧以内。node 不在线时立即回 `node-offline`。

## 持久化

控制库 `data/control.sqlite` 的 `admin` 模块表：`provider_credentials`（API key 的唯一一份）、`node_grants`（Agent 和 node ID 联合主键，主 node 不入表）和 `webhooks`（只存密钥哈希）。Agent 自己的配置在它的 Agent 文件里。
