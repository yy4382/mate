# 管理模块边界测试

> 这个模块的设计见同目录的 [ARCHITECTURE.md](ARCHITECTURE.md)。所有模块共用的测试规则和替身见 [docs/MODULE_TESTS.md](../../docs/MODULE_TESTS.md)。

**边界：** 管理模块的接口，以及它的 HTTP 路由（经 Web 外壳）。

**替身：** 真实 Manager、runtime 和聊天 app，真实网关加假 node，脚本化提供商（凭据的 `baseUrl` 指向它）。

- 设置模型时，只接受该提供商已经配置了 API key 的模型；不支持的 thinking 级别直接被拒绝，不会被悄悄降级。
- 模型列表只列已经存了 key 的提供商的模型，每个带它接受的 thinking 级别。
- 修改 API key 后，下一次模型请求使用新 key；用同样的值再保存一次，不会打断正在运行的 Agent。
- key 跨重启保存，列出时只显示末四位。
- 查看对话记录时，能实时看到流式输出和工具调用；查看不会改变 Agent 的任何状态。
- 能按名字查看工作助手的对话；没有这个助手、或 Agent 没有打开时拒绝。
- 浏览工作区在 Agent 的主 node 上进行，返回 node 的结果，别的 node 不被询问；暂停的 Agent 也能浏览，浏览不改变它的状态。node 拒绝的路径（比如逃出工作目录的）以 node 给的原因拒绝；node 离线时以 `node-offline` 拒绝；不存在的 Agent 和不合法的路径在询问 node 之前被拒绝。路径限定在工作目录里由 node 保证，在 8.4 测。
- 配对 node：生成的令牌只能用一次。
- 管理员改 node 名字，网关的拒绝原样转成 `AdminError`。Agent 列表的 `nodeName` 每次从网关读取，改名后立即变化，Agent 的 node ID 不变。
- 创建 Agent 时不合法的名字或 handle 以 `invalid-input` 拒绝，handle 被占用以聊天 app 的 `handle-taken` 拒绝（不是创建中途失败），已存在的 ID 以 `agent-exists` 拒绝；都什么都不创建。暂停、恢复、改设置排在删除之后得到 `unknown-agent`；观察或查助手时 Agent 被暂停，得到 `agent-closed`。
- 创建 Agent 时 node 必须已经配对，否则拒绝，聊天账号和文件都不会出现；工作目录建在所选主 node 上，缺省工具调用在那里执行，控制面重启后主 node 不变。
- 暂停 Agent 时，node 上进行中的命令经真实网关被停止；恢复后模型得知这次调用没有完成，命令不重跑。
- 列出 Agent 时，显示名和 handle 来自聊天账号，node、状态、设置和用量来自 Agent 文件；一个 Agent 的文件读不出来时，它以"读不出"和原因列出，可以删除，其他 Agent 照常列出。

- 新 Agent 只有主 node 可用；未知和未授权名字同样拒绝并列可访问名字，不向 node 发调用。在线授权返回前以 visit 准备工作区；访问调用以 visit、主 node 以 home 转发；node_list 每次现读并保持主 node 标记。
- 离线授权成功并持久化，重连后允许首次调用；在线准备失败报告错误但保留授权，重复授权重试准备。准备期间收回授权，迟到的准备完成不会恢复授权。
- 授权、收回幂等；主 node invalid-input，未知 Agent/node 分别拒绝；暂停的 Agent 也能授权，agents 显示当前授权名字。收回后新调用拒绝，已发出的前台和后台调用仍完成；目标离线错误标出名字，主 node 离线不阻止其他 node。
- 用已发布版本公开 API 创建并暂停的真实 Agent 夹具验证 admin 迁移。从 v0.1.0-alpha.2（admin 第 1 版）升级：凭据不变，初始无额外授权，原 Agent 仍只用主 node。从 v0.1.0-alpha.10（admin 第 2 版，已有授权表）升级到第 3 版，和 alpha.2 一样：webhook 列表为空且能新增，重新打开后仍在。

入站 webhook（经 `Admin` 接口，HTTP 在 [apps/control-plane/TESTS.md](../../apps/control-plane/TESTS.md)）：

- 投递唤醒打开的 Agent：观察的事件里看到包在 `external_webhook_content` 标签里、带 webhook 名字、ID、时间的输入和正文，模型的请求里也是这一段，系统提示有说明标签含义的那一段（这段的原文只在这里断言一次）；同一个 `Idempotency-Key` 只生效一次，重试不改任何东西；没有 key 时每次都是新的输入。
- 按需文档：Agent 每次请求都有 `palace_docs`，索引里有 `webhooks` 主题，读到的是 `packages/admin/docs/webhooks.md` 的原文。
- 未知 webhook 和错误密钥以相同的 `invalid-webhook`（相同消息）拒绝；暂停的 Agent 以 `agent-closed` 拒绝，恢复后也没有排队的输入：恢复后的下一次运行，模型的请求里没有被拒绝的那条内容。
- 轮换后旧密钥立即失效、新密钥可用；删除 webhook 后不再投递，重复删除或轮换为 `unknown-webhook`；删除 Agent 同时删掉它的 webhook；列出不含密钥；重启后 webhook 仍在。
- 空正文、超过 32 KiB（按字节）的正文、不合法的 key 和不合法的名字以 `invalid-input` 拒绝；名字和正文里的 `<`、`>`、`&`、引号和换行关不掉标签、加不进属性，也伪造不出另一个标签（只断言模型读到的是一个标签、三个属性，不断言具体转义写法）。
