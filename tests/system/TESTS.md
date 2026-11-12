# 系统场景

> 把整个系统当作一个模块的端到端测试。各模块的设计见 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) 第 4 节，共用的测试规则和替身见 [docs/MODULE_TESTS.md](../../docs/MODULE_TESTS.md)。

少量端到端测试，把整个系统当作一个模块：以真实子进程启动控制面和 node，模型用脚本化提供商，管理员的操作通过 HTTP 发出。它们证明各模块确实接在了一起；具体的边界情况应当在各模块的测试里覆盖，而不是在这里。

1. 管理员在频道里 @ 一个 Agent，Agent 读取后回复。
2. Agent 运行一条长命令期间，管理员又发了两条消息：Agent 收到一条通知，读到两条消息，完成命令后回复。
3. Agent 读完频道后、发言前，管理员又发了一条：Agent 的发言被拦下，它重新组织内容后再发。
4. Agent 执行命令期间控制面被 SIGKILL，然后重启：这条命令不会被再次执行，Agent 收到"已中断"，并继续工作。
5. Agent 执行命令期间 node 网络断开：Agent 收到"结果未知"，继续读写消息；node 恢复后，新的命令正常执行。
6. 管理员暂停一个正在运行的 Agent，再恢复：暂停期间模型没有被调用，恢复后 Agent 处理积压的通知。
7. 两个 Agent 在私信里协作：A 派一个任务给 B，B 认领并完成，A 收到通知。
8. Agent 派生一个工作助手执行命令，助手完成后汇报，Agent 把结果发到频道。
9. Agent 访问第二个 node：管理员授权前被拒绝，授权后准备工作区，不初始化 MEMORY.md，在自己的工作区内执行命令和读写编辑文件，实际 pwd 与工作区一致，主 node 文件独立，收回后再次被拒绝。离线授权在首次在线调用时准备工作区；重连和重复授权不改写已有文件。

**实现。** 九个场景在 `tests/system/test/`（pnpm 包 `@palace/system-tests`，根 `vitest` 的 include 里有 `tests/*/test`）：场景 1 到 3 在 `chat.test.ts`，4 到 6 在 `recovery.test.ts`，7 和 8 在 `agents.test.ts`，9 在 `node-visits.test.ts`，进程夹具在 `support.ts` 的 `startSystem()`。测试名字以场景号开头，场景 9 另含离线授权和重连测试。

- 控制面用 `node --conditions=palace-source apps/control-plane/src/main.ts` 启动，环境变量同部署；node 用 `palace node run`，HOME 是临时目录，配置里的配对令牌来自管理员经 HTTP 生成的令牌。模型提供商的凭据由管理员经 HTTP 保存，`baseUrl` 指向这个进程里的脚本化提供商。管理员用 `HumanBrowser`（`@palace/testkit`，控制面测试共用）。
- 不用 sleep。等待的都是可观察的状态：长命令在 Agent 的工作区里写 `started`，测试看到它才继续，要它结束时写 `release`；其余是轮询 HTTP（node 在线、频道里出现某条消息）。要卡在某个时刻的事（场景 3 里管理员在 Agent 读完之后、发言之前写）放在脚本化提供商的步骤里做：步骤收到请求时，先让测试发 HTTP，再给出回答。
- 场景 4：看到 `started` 后 SIGKILL 控制面，在同一个数据目录和端口上重启；命令把自己的运行次数追加到 `runs.log`，Agent 重启后用 `cat runs.log` 确认只有一次。node 的重连是真实的退避重连。
- 场景 5：node 经网络代理连到控制面，用 `disconnect` 模式断开（`blackhole` 要等 30 秒的心跳超时，且走的是同一条"连接丢失"路径）；断开时命令在网关的在途调用上以"结果未知"结束，node 停掉命令的进程组，恢复后 node 重连，新命令正常执行。
- 场景 6：暂停后命令的进程消失；"暂停期间模型没有被调用"由恢复后的那一步断言（恢复请求发出之前它不能被请求到），脚本外的请求本来就会让 `assertComplete()` 失败。
- 场景 7 和 8 用多条 lane 区分 Agent 与工作助手，用 promise 门控让"先发生"的事真的先发生（B 在 A 建好任务之后才读；助手在主对话收到派生结果之后才干活）。
- 场景 9 用 `addNode()` 启动第二个真实 node，两个 node 各有独立的主目录、工作区根和身份。授权和收回通过 HTTP 发出，命令与文件工具由脚本化模型驱动；网络代理切断和恢复真实 node 的连接以验证离线授权和文件保留。
- 不依赖 Linux 的行为，macOS 和 `pnpm test:linux` 都跑；每个场景在独立临时目录里起一套进程。
- 变异检查（临时改接线，确认场景失败，已还原）：把 `bash` 改成可重做，场景 4 失败；把聊天发送的 `freshness` 改成 `false`，场景 3 失败；把连接断开的结果从"未知"改成"离线"，场景 5 失败。
