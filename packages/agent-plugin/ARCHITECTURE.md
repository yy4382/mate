# Agent 插件契约（`@palace/agent-plugin`）

> 总览见 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)。这个包没有自己的 `TESTS.md`：插件只有装进 runtime 才有行为，它的行为由 [runtime 的测试](../runtime/TESTS.md) 经 `openAgentRuntime` 和 `submit` 覆盖。

## 职责

让一个 Agent 的能力在一处增删：谁拥有这个能力，谁就在自己的包里用一个插件交出它的工具、系统提示、输入种类和按需文档，runtime 不用改。包里只有契约，没有运行时逻辑；它只依赖 Durable 的 `ToolRegistration` 类型。

## 插件

`definePlugin({ name, scope, prompt?, tools?, inputs?, docs? })` 返回纯数据，没有生命周期钩子，也拿不到 Harness。需要每个 Agent 自己的状态时，在工厂函数里闭包（例如 `chatPlugin(account)`）。

- **`name` 一经发布就不能改。** runtime 把插件装成同名的 Durable 扩展，Durable 把扩展名存进每个工作助手对话的配置里（"这些扩展它没有"）。改名等于数据迁移。
- **`scope`** 是 `primary`（只有主对话）或 `every`（工作助手也有）。只有 `primary` 的插件能声明输入种类，类型上就禁止 `every` 带 `inputs`，因为输入只进主对话。
- **`prompt`** 是这个插件在系统提示里的那一段。它的每个输入种类的 `explain` 接在后面，用空格连接，成为同一段。
- **`tools`** 是 Durable 的工具注册，和 runtime 内置的工具写法相同。
- **`docs`** 是一个目录，里面每个 `<topic>.md` 是一个 `palace_docs` 主题（front matter 的 `description` 是索引里的一行）。用 `packageDocs(import.meta.resolve("@palace/<包>/package.json"))` 取包里的 `docs/` 目录，所以在 `src`、`dist` 和部署后的镜像里都能找到；这要求该包的 `exports` 有 `./package.json`，并把 `docs/` 随包部署。

## 输入种类

`defineInput({ name, explain, whenBusy, replacesQueued?, render })`。**一种输入怎么进入 Agent，全由它的种类决定**：

- `explain`：系统提示里关于这种输入的那一句。它是种类的必填字段，种类又只能列在一个插件里，所以一种输入不可能没有说明就进到 Agent。
- `render`：把载荷变成模型读到的文字。
- `name`：同时是 requestId 的命名空间，一个输入的 requestId 是 `<name>:<key>`。`key` 由发送方给，同一个 key 只生效一次。Durable 存 requestId 做去重，所以种类改名会让重启前后的去重失效。名字只允许小写字母和连字符。
- `whenBusy`：Agent 正在工作时，输入是插进当前这轮工具调用之后（`steer`），还是等当前工作结束（`followUp`）。
- `replacesQueued`：同一种类里还排着、没交给模型的旧输入先撤回，只留最新的。

`kind.input(key, payload)` 返回 `PluginInput`，`AgentRuntime.submit` 只收它。`PluginInput` 只有种类能造（构造函数需要包内的私有令牌，类型上由 `#kind` 区分），所以没有任何一条路径能把一段没人解释的文字交给 Agent。发送方不再传 requestId 字符串、`whenBusy` 或撤回前缀：以前 `notice:` 这个前缀在连接器和 runtime 里各写一遍，现在只在种类里写一次。

## 内置能力为什么不是插件

工作区、历史、助手、提醒和后台命令留在 runtime 里，仍是 Durable 扩展。它们要后台任务、Harness 句柄、时钟和中止，把这些放进契约就等于重新暴露 Durable 的整个 `Extension`，契约不再简单。判据是谁拥有它：不属于 runtime 的能力是插件，runtime 自己的能力是内置。两者共用的只有 `scope`，runtime 内部用一张 `{ extension, scope }` 的表装它们，主对话专属集合由 `scope` 推出来。

runtime 内置输入的 requestId 前缀（`reminder`、`assistant`、`assistant-report`、`command`）在 runtime 里集中列出，插件的输入种类不能和它们同名。

## 不做的事

按 Agent 选择装哪些插件、运行时动态加载插件都不做。Manager 给每个 Agent 装同一组插件。
