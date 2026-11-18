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
8. Agent 派生一个后台子 Agent 执行命令，子 Agent 完成后以 `<subagent_result>` 汇报，Agent 把结果发到频道。
9. Agent 访问第二个 node：管理员授权前被拒绝，授权后准备工作区（不初始化 `memory/` 或 `MEMORY.md`），在自己的工作区内执行 `exec_command` 和文件读写编辑；离线授权在首次在线调用时准备工作区并保留文件；跨 node 终端会话只凭 `session_id` 将后续 `write_stdin` 自动路由到最初执行的 `laptop` node。
10. `$PALACE_MEMORY_DIR/MEMORY.md` 写入记忆后下一轮自动进入 `<memory_index path="memory/MEMORY.md">`，以及使用 `write_stdin` 交互管道和 `notify_on_exit: true` 结束 turn 后自动通过 `<command_notification>` 唤醒。

**实现。** 这些场景位于 `tests/system/test/`：场景 1 到 3 在 `chat.test.ts`，4 到 6 在 `recovery.test.ts`，7、8 和 10 在 `agents.test.ts`，9 在 `node-visits.test.ts`，进程夹具在 `support.ts`。
