# Node 网关（`@palace/gateway`）

> 总览见 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)。node 一侧见 [apps/node/ARCHITECTURE.md](../../apps/node/ARCHITECTURE.md)。线路消息格式和 `bash` 工具定义在 `@palace/node-protocol`。测试见 [TESTS.md](TESTS.md)。

## 职责

网关在控制面里，负责 node 的配对、认证和心跳，并把工具调用转发给 node。授权（哪个 Agent 能用哪个 node）由管理模块决定，网关只执行管理模块给出的 `home` 或 `visit` 关系。

## node 的身份、名字和系统信息

UUID 是 node 的身份，配对、签名认证、工具调用和 Agent 文件都用它。名字是管理员可改的人读名字，在已配对 node 中唯一，1 到 32 个小写字母、数字或 `-`，以字母或数字开头。新配对的 node 用规范化的 hostname 作名字，冲突时加 `-2`、`-3`。

系统信息是 node 每次握手现取的一份完整报告：`platform`、`arch`、`hostname`、`osRelease` 和发布版本 `version`（源码运行时为 `dev`）。配对时，令牌消耗、身份、名字、系统报告和连接时间在同一个事务提交。认证时先更新报告和连接时间，再登记在线连接。改名只改名字。网关的拒绝用 `NodeGatewayError` 表示，不改变已存事实。

## 工具调用按整个调用转发

runtime 把一次完整的工具调用（工具名、参数、可选 node 名字）交给工作区端口，管理模块检查授权、选择目标后交给网关，网关发给 node，node 在本地执行并流回输出，最后返回结果。每次工具调用只有一次往返，不需要在网络上逐个实现 Durable 执行环境的二十多个文件方法。

网关为每次调用生成随机 UUID 作请求 ID，输出、结果和停止都按它对应。调用方的 ID 不上线路，所以不同 Agent 的调用不会撞号。node 调用不按 ID 去重：有副作用的工具崩溃后不重做（runtime 规则 2），可重做的 `read` 重做一次也无妨。

## 接口

给管理模块用，签名在 `src/index.ts`。

- `runTool(nodeId, agentId, { access, conversationId?, tool, arguments }, onOutput, signal)` 转发一次调用。从不重发，也没有自己的期限，在 node 回答、连接断开或 signal 中止时结束。
- `prepareWorkspace(nodeId, agentId, access)`：`home` 创建工作区和缺失的 `MEMORY.md`，`visit` 只创建工作区。可重复，离线返回错误。
- `browse(nodeId, agentId, path)` 只读地看工作区里的一个路径，给管理界面用。
- `status`、`nodes`、`renameNode`、`createPairingToken`（一次性）、`handleUpgrade`（挂到外壳的 HTTP upgrade）、`close`。

## 规则

1. **控制面从不重发工具调用，也不给调用设期限。** 连接是否活着由心跳判断，命令跑多久由 `bash` 自己的 `timeout` 决定。连接断了，进行中的调用立即以"结果未知：节点连接中断，命令可能执行了也可能没有，不会重试"交给模型，迟到的结果丢弃。所以没有回执对账，node 不需要操作账本，控制面也不需要定期核对。

2. **node 离线时 Agent 照常运行。** 需要该 node 的工具返回"节点离线"，管理模块在错误里标出目标名字。一个 node 离线不影响访问其他 node。

3. **谁在等结果，谁决定停。** 停止只有一种方式：调用方中止自己那次调用的 signal，网关向 node 发这次调用的停止消息。暂停 Agent 就是关闭 runtime，runtime 中止所有进行中调用的 signal，所以没有另一个"按 Agent 停止"的入口。

4. **身份被拒绝时 node 退出，网络失败时重连。** 网关拒绝身份或令牌时发 `gateway.refused`，node 以 78 退出，不重试。网关因用法错误（格式、顺序、握手超时、内部错误）结束连接时发 `gateway.error`，node 和网络中断时一样，从 250ms 起倍增、最多 10 秒重连。退出还是重连由消息类型决定，node 不维护错误码清单。

5. **先签名，令牌只在"不认识"之后用。** node 每次连接先用签名认证，只有网关明确回答 `unknown_identity` 时才改用配对令牌。配对令牌只存 SHA-256 哈希，只能用一次，过期作废。配对只新增 node，已配对的 node ID 不能再配对，公钥不变。

6. **一个 node 一条连接，调用绑定在连接上。** 同一个 node 新认证的连接关闭旧连接。调用只接受发出它的那条连接送回的输出和结果。连接结束时，它带着的调用以"结果未知"结束并被忘掉。

7. **违规的连接立即结束。** 未认证的连接最多 32 条。单条消息不超过 1 MiB。无法解析、不认识的消息、认证前发别的消息、重复认证，网关回一个 `gateway.error` 后关闭连接，并且不再读这条连接的任何内容。心跳超时同样结束连接。

## 升级顺序

控制面先于 node 升级，node 不能比控制面新。新版 node 在握手时声明 `workspaceVisits: true`，网关只在当前连接上保存这个声明，不落库，也不从版本号推断。没有声明的连接仍可执行主 node 操作，但网关拒绝向它发 `visit` 的准备和工具调用，提示升级目标 node。准备消息的 `access` 缺省为 `home`，保留旧调用的含义。

## 持久化

node 注册表（身份、公钥、名字、系统报告、连接时间）和配对令牌存在控制库 `data/control.sqlite` 的 `gateway` 模块表里，控制库规则见总览的数据布局。
