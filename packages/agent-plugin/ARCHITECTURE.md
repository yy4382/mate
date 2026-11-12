# Agent 插件契约（`@palace/agent-plugin`）

> 总览见 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)。这个包没有自己的 `TESTS.md`：插件只有装进 runtime 才有行为，它的行为由 [runtime 的测试](../runtime/TESTS.md) 经 `openAgentRuntime` 和 `submit` 覆盖。

## 职责

让一个 Agent 的能力在一处增删：谁拥有这个能力，谁就在自己的包里用一个插件交出它的工具、系统提示和按需文档，runtime 不用改。包里只有契约，没有运行时逻辑；它只依赖 Durable 的 `ToolRegistration` 类型，`packageDocs` 用 `node:path` 和 `node:url`，所以只在 Node 里用。

## 插件

`definePlugin({ name, scope, prompt?, tools?, docs? })` 返回纯数据，没有生命周期钩子，也拿不到 Harness。需要每个 Agent 自己的状态时，在工厂函数里闭包（例如 `chatPlugin(account)`）。

- **`name` 一经发布就不能改。** runtime 把插件装成同名的 Durable 扩展，Durable 把扩展名存进每个工作助手对话的配置里（"这些扩展它没有"）。改名等于数据迁移。
- **`scope`** 是 `primary`（只有主对话）或 `every`（工作助手也有）。
- **`prompt`** 是这个插件在系统提示里的那一段。插件的输入怎么读（例如 webhook 标签的含义）也写在这里。
- **`tools`** 是 Durable 的工具注册，和 runtime 内置的工具写法相同。
- **`docs`** 是一个目录，里面每个 `<topic>.md` 是一个 `palace_docs` 主题（front matter 的 `description` 是索引里的一行）。用 `packageDocs(import.meta.resolve("@palace/<包>/package.json"))` 取包里的 `docs/` 目录，所以在 `src`、`dist` 和部署后的镜像里都能找到；这要求该包的 `exports` 有 `./package.json`，并把 `docs/` 随包部署。

## 内置能力为什么不是插件

工作区、历史、助手、提醒和后台命令留在 runtime 里，仍是 Durable 扩展。它们要后台任务、Harness 句柄、时钟和中止，把这些放进契约就等于重新暴露 Durable 的整个 `Extension`，契约不再简单。判据是谁拥有它：不属于 runtime 的能力是插件，runtime 自己的能力是内置。两者共用的只有 `scope`，runtime 内部用一张 `{ extension, scope }` 的表装它们，主对话专属集合由 `scope` 推出来。

## 不做的事

按 Agent 选择装哪些插件、运行时动态加载插件都不做。Manager 给每个 Agent 装同一组插件。
