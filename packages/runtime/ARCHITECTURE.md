# Agent runtime（`@palace/runtime`）

> 总览见 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)。测试见 [TESTS.md](TESTS.md)。

## 职责

运行一个 Agent。runtime 包装一个 `pi-durable` 的 Harness，即 Durable 里"一个存储加上在其上运行 agent 的机制"的对象。Durable 负责 loop、重试、对话记录、收件箱和压缩，runtime 在上面装扩展。

消息、任务、已读位置等业务事实都归聊天 app。runtime 不判断"run 是否仍然有效"，runtime 开着它就有效。

每个 Agent 一个 runtime、一个 Harness、一个 SQLite 文件。文件里有一个主对话和若干工作助手对话，它们共享模型设置和凭据。

## 扩展

| 扩展 | 内容 | 谁能用 |
| --- | --- | --- |
| 聊天 | 读未读、回看、搜索、发送、加入或离开频道、打开私信、任务操作。系统提示说明普通输出不会发到任何地方，发言必须调用发送工具；通知只是提示，什么时候读由 Agent 决定 | 主对话 |
| 工作区 | `bash`、`read`、`write`、`edit` 接受可选的 node 名字，缺省在主 node 执行；`node_list` 每次现读可访问的 node；`bash_stop` 停止后台命令。系统提示说明每个 node 有自己的工作区、互不同步，主 node 工作区的 `MEMORY.md` 是记忆入口 | 主对话和助手 |
| 提醒 | 设定、列出、取消提醒 | 主对话 |
| 助手 | 派生、发消息、等待、中断、列出工作助手 | 主对话 |
| 历史 | `history_search`、`history_read` 查这个对话自己的历史，包括被压缩掉的部分 | 主对话和助手 |
| 文档 | `palace_docs({ topic })` 读一篇 Palace 功能文档 | 主对话和助手 |

系统提示分在各扩展里，一件事只在一处说。工具和参数的描述只写它们自己的意思。工作助手的对话另有一句说明它是谁，主对话没有"你是谁"一段。所有工具直接暴露给模型，不经过"先列出、再调用"的元工具。

## 助手投递

进入工作助手对话的输入只有一条路，即投递：主对话里的一个 Durable 后台任务。它把输入（带 `requestId`）提交给目标对话，目标是助手时再等助手回答，把回答以 `[assistant <名字> answered] <回答>` 作为 `followUp` 提交给主对话（`requestId = assistant-report:<投递任务 ID>`）。每一步都有检查点，所以重启后助手只收到一次输入，主对话只收到一次汇报。主对话的 `send`、`spawn` 和助手后台命令的结束都走投递，所以助手的每个回答都会回到主对话。

## 后台命令

`bash` 带 `background: true` 时，runtime 在发起它的对话里建一个 Durable 后台任务，把任务 ID 作为命令 ID 立即返回给模型。后台任务不让对话保持忙碌，也不随 run 结束或中止，所以 Agent 照常工作、照常空闲。任务把调用交给网关并等结果：

1. 交给网关之前先记下"已交给 node"。重新打开的 runtime 发现任务停在这里，就知道命令可能跑过，也可能没跑完。它汇报"已中断"并写明这两种可能，不重跑。
2. 命令结束后，在同一次提交里结束任务，并为发起的对话建一个投递（`requestId = command:<ID>`，`steer`），内容是结果全文，第一行写命令 ID、成功或出错、命令本身，显式指定了 node 时也写目标名字。两件事一起提交，所以结果恰好汇报一次。

后台命令的输出不流式显示，只在汇报里出现。`bash_stop(ID)` 中止那个任务，任务的 signal 随之中止，网关停掉 node 上的调用，和前台调用的停止是同一条路。被停止的命令不再汇报。只能停自己对话的后台命令；不认识的 ID 返回错误，已结束的命令返回普通结果说明它已结束。命令结束和交出汇报是同一次提交，所以停止要么在它之前（不汇报），要么在它之后（已结束）。runtime 关闭时后台命令被停掉，重新打开后以"已中断"汇报一次。没有列出后台命令的工具，命令 ID 在 `bash` 的结果里，压缩后也能用历史工具查到。

后台命令的输入是版本 1 的平铺参数加可选的 `node`，旧记录没有 `node` 时按主 node 处理。

## 按需文档

功能怎么工作（接口、鉴权、幂等、限制）不进系统提示，因为大多数运行用不到。Agent 为读懂输入而必须知道的内容（例如 `<external_webhook_content>` 标签的含义）留在系统提示或输入里，越短越好。其余写进 `docs/<topic>.md`，Agent 需要时调用 `palace_docs` 读。

每个主题一个文件，front matter 的 `description` 是索引里的一行。打开 runtime 时从这些文件生成 `topic` 的枚举和工具描述里的索引，没有另一份列表。枚举之外的主题被 Durable 的参数校验拒绝。工具经 `@palace/runtime/package.json` 解析文件路径，所以在 `src`、`dist` 和部署后的镜像里都能找到。文档面向模型，用英文写，不含各部署自己的值（例如服务器地址）。

## 聊天端口

runtime 不依赖聊天 app 的代码。它定义 `ChatPort`：绑定到一个账号的聊天操作。参数是模型给的参数加上 `requestId = tool:<Durable 工具任务 ID>`，结果原样转成 JSON 交给模型。Agent Manager 把 `ChatApp.forAccount` 的结果交给它。发送和任务操作总是带 `freshness: true`，模型参数里没有这一项。聊天 app 的拒绝作为错误结果交给模型，不算工具失败。

## 压缩与历史

压缩用 Durable 的 `settings.compaction`，摘要由对话自己的模型生成。上下文让模型窗口只剩不到 16384 token 时先压缩再发请求；早 32768 token 时在后台开始压缩；摘要后保留最近约 20000 token 原文。摘要失败时上下文保持原样；提供商以"上下文太长"拒绝时先压缩再重试一次。这些由 Durable 保证，runtime 只给出这三个数。

被压缩的部分仍在 Durable 存储里。历史扩展把输入、模型回答（含工具调用）和工具结果当作历史记录，按存入顺序从 1 编号。系统提示的变化、摘要和历史工具自己的调用不算记录，否则每查一次下次就多出匹配。Durable 只追加，所以编号不变。

- `history_search(query)` 不分大小写，返回最新的 20 条匹配，每条只给匹配附近约 400 个字符，并给出匹配总数。
- `history_read(from)` 从编号 `from` 起按顺序读，一页最多 40000 字节的 JSON，保证在 Durable 单个工具结果 50 KB 的上限之内，不被截成无效 JSON。

结果带记录总数和 `inContextFrom`，即还在模型上下文里的第一条记录的编号。两个工具都只读、可重做。

## 接口

给 Agent Manager 和连接器用，签名在 `src/index.ts`。

- `createAgentStore(file, { nodeId, settings })` 新建 Agent 文件，node ID 和设置一次写入，之后 node ID 不变。返回时 Agent 就存在了。
- `openAgentRuntime({ file, credentials, workspace, chat?, … })` 打开 Harness 并 `resume()`。`credentials(provider)` 在每次模型请求时现读，改了 key 从下一次请求生效。存储出错时调用一次 `onFatal`，之后这个 runtime 失效，要从文件重新打开。
- `AgentRuntime` 提供 `submit`（可带 `replaces` 撤回同前缀的未交付输入）、`withdraw`、`cursor` / `advanceCursor`（只进不退）、`configure`、`settings`、`idle`、`usage`、`assistants`、`watchEvents`（只读观察）和 `close`。
- 在没打开 runtime 的文件上：`readAgentState`、`setAgentPaused`、`configureAgentFile`，只给 Manager 处理关闭状态的 Agent 用。
- `CHAT_READ_UNREAD` 导出读未读的工具名，连接器在通知里引用它。`catalogModels(provider)` 读 pi-ai 模型目录。

## 规则

1. **runtime 的全部状态都在 Durable 存储里。** 提醒、连接器位置、是否暂停都存为 Durable 自定义文档（`defineDoc`），和对话记录一起提交。
2. **只读、可重做的工具声明 `replay: "safe"`，有副作用的不声明。** 崩溃后 Durable 让没声明的调用以"已中断"结束并告诉模型。聊天工具靠 `requestId` 幂等，所以可以声明。
3. **配置改动不追溯。** 已发出的请求按旧配置完成，改动从下一次请求生效。崩溃后 Durable 可能按旧配置重发一个已准备好的请求，这可以接受。
4. **用量直接读 Durable 的 `pi.usage`，只用于观察，不设配额。**
5. **提醒到期时提交 `requestId = reminder:<id>` 的输入，由 Durable 去重。** 不需要轮询循环或另一条唤醒路径。

## 持久化

`data/agents/<agentId>.sqlite`，WAL 加 `synchronous=FULL`（由传入的 SQLite 适配器设置）。
