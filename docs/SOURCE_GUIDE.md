# 源码导航与类型约定

第一次接触 Mate，可以先看下面的入口，再沿实际请求走向阅读。产品概念以根目录 `CONTEXT.md` 为准，运行和检查命令见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 四个 package

| 位置 | 负责什么 | 建议从哪里开始 |
| --- | --- | --- |
| `apps/web` | 所有者使用的中文网页 | `src/main.tsx`，然后进入相应功能目录 |
| `apps/control-plane` | 登录、持久状态、会话和工具循环、调度与请求路由 | `src/main.ts` 装配，`src/http.ts` 处理 HTTP 与事件流 |
| `apps/node` | 机器连接、Agent 工作区、文件与命令执行、本地收据 | `src/main.ts`，然后看 `src/connection/node-client.ts` |
| `packages/protocol` | 跨 package 的运行时数据契约及其推导类型 | `src/owner.ts`、`src/workspace.ts` 和节点消息、操作契约 |

控制面拥有模型循环，节点不运行模型。一次 run 结束也不表示消息关联的任务已经完成。

## 控制面按领域找代码

- `conversations/`：频道、私信、消息、已读与暂缓、消息关联任务和提醒。`service.ts` 保留事务与业务编排；`contracts.ts` 是请求校验，`rows.ts` 解释数据库查询结果，`tool-contracts.ts` 描述 Agent 能看到的工具。
- `agents/`：Agent 身份、资料、创建与目录；供应商模型的校验仍在控制面，不能带进浏览器。
- `runtime/`：run 调度、模型循环、操作收据与恢复、活动和用量。`session/` 管完整历史和压缩，`tools/` 管工具入口和当前 run 检查；`provider-response.ts` 只解释供应商响应中的结束和用量证据。
- `workspaces/`：文件浏览、下载和 Agent 文件操作的控制面逻辑。`contracts.ts` 和 `results.ts` 分别放请求契约与结果解释；副作用提交顺序留在服务中。
- `attachments/`：附件操作及相应工具描述。
- `nodes/`：控制面的节点目录和连接路由；与 `apps/node` 的机器端代码不同。
- `auth/`、`providers/`、`notifications/`：所有者登录、模型凭据和供应商目录、网页推送。
- `storage/`：数据库初始化与各领域表的装配。领域里的 `schema.ts`、`*-schema.ts` 是 SQL 表定义，与 Zod 的 `contracts.ts` 分工不同。

没有为了缩短文件而引入通用仓储层，也没有把事务拆成通过庞大上下文对象相互调用的小函数。跨领域操作仍应能看清在哪个事务里提交。

## 节点按执行职责找代码

- `connection/`：节点身份、配对、WebSocket 连接及重连。
- `provisioning/`：准备同一运行账号下的 Agent 默认工作区。
- `files/`：文件操作入口、辅助进程、路径检查与原子文件操作。
- `processes/`：普通命令、进程状态、操作运行与持久收据。

对应测试也按这些目录组织。外部使用节点时，依赖 package 的明确导出；内部移动文件不要求调用方知道新的磁盘路径。

所有者主动运行的供应商协议检查位于控制面 `providers/active-check.ts`，`active-check-cli.ts` 负责显式模型选择、私密凭据文件和终端取消。它使用现有 Pi 库，独立于 Mate 的持久 Agent/session 和 node；合成 HTTP/SSE 验证在 `tests/providers/active-check.test.ts`。入口与结果含义见 [DEVELOPMENT.md](DEVELOPMENT.md#所有者主动检查真实模型供应商)。

## 真实进程场景辅助代码

`apps/control-plane/tests/helpers/scenario-environment.ts` 接收结构化服务和 Agent 配置，拥有登录、配对、工作区准备、保留身份的重启、资源登记与尽力清理。`scenario-services.mjs` 是使用本次构建结果的固定测试启动文件；`run-services.ts` 提供真实输出等待、输出游标、取消与有界停进程。模型输出沿用 `agent-loop.ts` 的本地 HTTP/SSE handler 和 `respond`。`scripted-provider.ts` 按 Agent 原 session 关联命名普通函数步骤，负责响应释放、取消与截止时间；`scripted-tool-results.ts` 通过真实调用 ID 读取工具结果并复用领域 schemas。`tests/control-plane/scripted-provider.test.ts` 包含同 model 双 Agent 交错工具、真实摘要与失败路径探针。`tests/control-plane/scenario-environment.test.ts` 从真实 Owner API、模型工具结果和文件字节验证生命周期；新增场景入口与使用边界见 [DEVELOPMENT.md](DEVELOPMENT.md)。

`scenario-driver.ts` 集中读取 Owner 消息、任务、活动与附件，提供带期限和最后事实的条件等待，以及消息/run/当前游标的关联。`scenario-facts.ts` 只读补充 Owner API 没有暴露的 session、run seed 和实际已提交投递关系；业务结果仍由真实工具产生。`tests/control-plane/scenario-driver.test.ts` 先完成旧 run，再用新 Owner 普通消息驱动任务、命令生成文件、附件发布和显式线程回复，核对 Owner 下载与实际工作区字节；同时覆盖旧完成记录、取消、读取停滞、任务/run 分离、提醒和普通消息的实际输入，以及 seed 输入未提交前的中断/恢复。

`scenario-evidence.ts` 用同一环境生命周期包装场景，保留原始失败、清理前的合成证据及释放结果；`scenario-cleanup.mjs` 提供驱动 SIGKILL 后的独立、归属核验回收入口。`scenario-evidence.test.ts` 是短真实文件成果、失败／取消／再运行的使用样例。文件目录可直接作 CI artifact，操作方式见开发说明的“场景失败证据与独立回收”。

`tests/scenarios/report-workflow.ts` 是完整正常工作样例：甲从 Owner 普通请求创建／认领任务、真实生成草稿，经 peer DM 附件让乙独立复核，乙真实反馈后甲继续原 session 的第二轮并交付最终报告。它同时保留模型脚本与任务、消息路由、文件／附件字节、session／run 断言，供现有环境的其它拓扑复用；`tests/control-plane/report-workflow.test.ts` 只装配同一 `runScenario` 入口。开发说明的“新增正常工作场景”展示短单 Agent 写法和完整样例入口。

`tests/control-plane/command-crash-recovery.test.ts` 补充命令 start 后执行前／效果后收据前的真实 node SIGKILL 与恢复后的主动效果检查。`scenario-command-boundary.mjs` 只在固定测试启动文件注入既有真实 ledger/executor，暂停可释放、取消并有期限；`scenario-command-facts.ts` 在既有只读事实投影上解析命令身份、收据和实际模型可见的更正。收据已持久化后失效／对账继续复用 `agent-tool-invalidation.test.ts` 的命令用例；覆盖映射与运行入口见开发说明的“真实命令的 node 崩溃与收据边界”。

`scenario-network.ts` 只控制环境主 node 的原始 TCP 链路，提供立即断开、双向静默丢帧、明确恢复和带游标／期限的帧观察；它不回复心跳。`scenario-network-facts.ts` 集中读取 Owner API 没有暴露的提醒投递与待处理队列。`tests/scenarios/node-network-recovery.ts` 保留可复用的普通请求断网／接续脚本与断言；`tests/control-plane/node-network.test.ts` 还覆盖实际摘要、离线队列、人工暂停、独立在线节点和观察取消。网络事件沿现有失败证据与环境清理入口保存。

`tests/control-plane/cp-recovery-scenarios.test.ts` 复用并迁移既有 CP 提交、任务收据、压缩、部分 SSE 与 SIGTERM 恢复覆盖，使用同一场景 ID/证据机制。`tests/scenarios/cp-restart.ts` 保留选定提交后重启场景的模型和成果断言供容器复用；`scenario-recovery-facts.ts` 集中只读补充原 session/run、完整提交与收据事实，Owner API 和实际模型请求仍为主要证据。固定测试启动器仅注入既有提交钩子及 Pi 参数 delta 观测；具体边界与入口见开发说明的“控制面提交与重启恢复场景”。

## 网页按用户功能找代码

下面的功能目录都位于 `apps/web/src/features/`。

- `conversations/`：聊天、频道弹窗、消息列表与消息关联任务。
- `agents/`：Agent 页面、资料编辑、草稿与活动展示。
- `workspace/`：工作区浏览、下载操作及状态查询。
- `nodes/`、`tasks/`、`reminders/`：相应管理页面。

页面和相关样式放在同一功能目录。共享登录和请求处理保持独立；跨请求的取消、过期响应和重新连接仍由原有状态边界管理。

## 数据契约如何共用

Zod schema 是需要运行时校验的领域数据的类型来源。`z.infer` 或 `z.output` 表示解析后的值；带默认值或转换的输入使用 `z.input`。本地临时值和简单实现函数优先使用推导，模块接口和需要约束的公共形状保留显式类型。

浏览器使用 `@mate/protocol/owner` 和 `@mate/protocol/workspace`，避免依赖含 Node 专用校验的根导出或供应商 SDK。网页只需要静态形状时使用 `import type`；HTTP 和事件流响应需要实际校验时，使用这些浏览器安全的 Zod 契约及保留额外字段的显示投影。运行时校验会引入 Zod，但不应引入 Node 专用工具或模型 SDK。

数据库查询的参数和行类型写在查询边界；对不可信持久数据或外部结果使用已有 Zod 契约或明确的类型收窄。不要靠 `as` 跳过检查，也不要为了消除一个断言而发明通用框架。

Pi 会话保留供应商扩展字段。会话边界的窄适配不能改成会删掉未知字段的重新构造；变更 Zod schema 时也必须保留原本的严格或宽松行为、默认值、错误映射和恢复含义。

控制面容器交付位于 `deploy/control-plane`：`Dockerfile` 生成生产镜像，`compose.yaml` 仅运行控制面，`compose.initialize.yaml` 只供首次密码初始化，`entrypoint.mjs` 检查普通账号与私有挂载，`build.mjs` 和 `verify.mjs` 是明确版本本地构建及隔离接口验收入口。

真实文件崩溃场景在 `tests/control-plane/file-boundaries.test.ts`，复用同一环境、脚本 provider、驱动与失败证据。固定启动器的 `scenario-file-boundary.mjs` 通过 `@mate/node/workspace-execution` 和 `@mate/node/same-account-files` 的明确导出，只包住真实 `LinuxWorkspaceExecutor` 和 `SameAccountFileBackend` 的执行／收据边界，记录带实际操作身份的事件；无生产故障开关。`scenario-file-facts.ts` 校验现有只读动作投影、模型真正收到的收据更正与文件版本。原 `agent-tool-invalidation.test.ts` 的文件路径继续覆盖断链与收据对账，并核对可变 requestId 和稳定 operation／Agent／请求摘要。

文件启动器用 `AsyncLocalStorage` 保留每个真实请求的身份，使并发 Agent 的文件完成不会错归目标收据边界。双 Agent 回归用有界的首个执行暂留验证这个观察契约；会话事实投影也用于核对原 run 已提交的调用及崩溃前完整模型输入前缀。

交付拓扑的测试适配在 `tests/helpers/scenario-container.ts`，由同一 `scenario-environment.ts` 的 `container: { image }` 配置选择；测试 override 只存在于场景合成目录。`tests/container/run.mjs` 使用 B 原构建入口创建当前 SHA 的唯一镜像，`delivered-scenarios.integration.ts` 复用正常 workflow 与两个选定恢复导出，并验证驱动 SIGKILL 后的独立回收。生产交付文件不导入这些测试代码；完整入口、实际证据与未验证边界见开发说明。
