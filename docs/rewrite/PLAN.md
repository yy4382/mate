# 重写计划

> 这份计划在重写完成后删除。每个里程碑完成时，在下面打勾，并写上验证它的提交。

## 包结构

模块边界用 pnpm 包来强制：每个包只通过 `package.json` 的 `exports` 暴露公开接口，从外部 import 包的内部文件会直接构建失败。

| 包 | 内容 |
|---|---|
| `packages/chat`（`@mate/chat`） | 聊天 app |
| `packages/runtime`（`@mate/runtime`） | Agent runtime 及其扩展 |
| `packages/manager`（`@mate/manager`） | Agent Manager 和连接器 |
| `packages/node-protocol`（`@mate/node-protocol`） | 网关与 node 之间的消息格式，包括工具名和工具结果的形状 |
| `packages/clock`（`@mate/clock`） | 时钟：`now` 和可中止的 `sleep`，各模块共用，测试里换成可控时钟 |
| `packages/gateway`（`@mate/gateway`） | node 网关 |
| `packages/control-store`（`@mate/control-store`） | 控制库：几个模块共用 `control.sqlite` 时，各自打开自己的表并按模块检查结构版本 |
| `packages/admin`（`@mate/admin`） | 管理模块 |
| `packages/testkit`（`@mate/testkit`） | 测试替身和工具，只给测试用 |
| `apps/control-plane` | Web 外壳后端和组装入口 |
| `apps/web` | 前端 |
| `apps/node` | node 进程和 `mate node` CLI |

## 里程碑

按"风险最大的未知先做"排序。每个里程碑的完成标准，是 `MODULE_TESTS.md` 里对应的条目全部通过，并且经过一次独立审查。

- [x] **M0 骨架。** workspace、严格的 TypeScript、vitest、prettier，以及 `pnpm check`（格式、类型检查、测试）。完成标准：空包上 `pnpm check` 通过。验证：b9391c2f。
- [x] **M1 runtime 与测试工具核心。** 脚本化提供商、故障存储适配器、`AgentRuntime` 的打开、提交、撤回和关闭。先验证我们依赖的 Durable 行为：`requestId` 去重、steer、撤回、可重做与已中断、工具调用 ID、用量。完成标准：MODULE_TESTS 4.1 到 4.4 通过。验证：b9391c2f、22c907d1、61da1346、7744fad4，并经过独立审查。两处随别的里程碑完成：压缩相关条目（含摘要请求中的 `close()`）随 M5；"`close()` 时 node 上进行中的工具调用被停止"经真实网关的部分随 M4。
- [x] **M2 聊天 app 核心。** 账号、会话、时间线、发送、读取、新鲜度检查、回执、收件事件、未读摘要、任务。完成标准：MODULE_TESTS 3.1 到 3.7 通过。验证：65f1d04c、f0ddf369、14dbc927、61da1346（独立审查后的修复）。3.4 到 3.6 里涉及推送队列和实时事件的部分随 M6 的 3.8、3.9 一起验证。
- [x] **M3 连接器、Manager 和聊天工具。** 进程内跑通：所有者发消息，Agent 收到通知，读取后回复。完成标准：MODULE_TESTS 第 5 节、第 6 节中不涉及 node 的条目通过。验证：5c4ed765、12895fac、2d809428、61da1346（独立审查后的修复）。
- [x] **M4 node 链路。** 网关与 node 之间的协议；node 用 Durable 的工具在本地执行。完成标准：MODULE_TESTS 第 7、8 节通过。验证：395db848、bd559b39、2445ee80、2b0cc29f（独立审查后的修复），第 8 节用 `pnpm test:linux` 在非 root 的 Linux 容器里以子进程运行。runtime 的 `WorkspacePort` 接到 `gateway.runTool` 的组装在 M6 做，届时补一条经真实网关的"暂停停掉 node 上的命令"测试。
- [ ] **M5 runtime 其余部分。** 工作助手、提醒、历史、压缩。完成标准：MODULE_TESTS 4.5 到 4.7 通过。工作助手和提醒已提前完成（b1895d7a、61da1346）；4.7 的用量测试已在 7744fad4 完成；剩历史、压缩，以及后台命令（架构第 11 节第 4 条）。
- [ ] **M6 管理模块与 Web 外壳后端。** 登录、HTTP 路由、实时事件流、推送；网关注册表并入 `control.sqlite`，Agent 创建时选 node。附件推到首版之后。完成标准：MODULE_TESTS 3.8、3.9、第 10 节、11.1 通过。
- [ ] **M7 前端。** 完成标准：MODULE_TESTS 11.2 通过。
- [ ] **M8 打包。** 控制面 Docker 镜像、node 发布包、`mate node` CLI。完成标准：MODULE_TESTS 第 9 节通过。
- [ ] **M9 系统场景。** 完成标准：MODULE_TESTS 第 12 节通过。

- [ ] **CI。** GitHub Actions 在每次推送时跑 `pnpm check` 和 `pnpm test:linux`。

M9 完成后，只剩真实提供商接入和 VPS 部署。
