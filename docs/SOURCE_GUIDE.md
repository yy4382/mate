# 源码导航与类型约定

第一次接触 Mate，可以先看下面的入口，再沿实际请求走向阅读。产品概念以根目录 `CONTEXT.md` 为准，运行和检查命令见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 四个 package

| 位置 | 负责什么 | 建议从哪里开始 |
| --- | --- | --- |
| `apps/web` | 所有者使用的中文网页 | `src/main.tsx`，然后进入相应功能目录 |
| `apps/control-plane` | 登录、持久状态、会话和工具循环、调度与请求路由 | `src/main.ts` 启动，`src/application.ts` 组装服务与领域应用，`src/http.ts` 定义登录、推送和网页路由 |
| `apps/node` | 机器连接、Agent 工作区、文件与命令执行、本地收据 | `src/main.ts`，然后看 `src/connection/node-client.ts` |
| `packages/protocol` | 跨 package 的运行时数据契约及其推导类型 | `src/owner.ts`、`src/workspace.ts` 和节点消息、操作契约 |

控制面拥有模型循环，节点不运行模型。一次 run 结束也不表示消息关联的任务已经完成。

## 控制面按领域找代码

- `conversations/`：从 `http.ts` 的所有者动作进入实际领域能力。`service.ts` 的 `createOwnerChat` 用共享数据库和时钟装配这些能力，只集中 snapshot 读事务和 Agent 工具目录组合。`channels/membership.ts` 实现频道创建、更新、加入和邀请；`channels/directory.ts` 提供对话事实、成员读取与唯一私信，调用方通过 `chat.channels` 和 `chat.conversations` 直达。`messages/writer.ts` 保存消息及收据更正，`timeline.ts` 提供消息分页、讨论串与读取后的 presented 标记，`attention.ts` 管注意力、草稿和讨论位置检查；`deliveries.ts` 管成员快照、pending/handled 和 run 完成。`tasks/service.ts` 管任务创建、责任、活动与草稿，`reminders.ts` 管提醒和专用单接收者投递。消息、任务和讨论位置的长输入使用具名参数，草稿选择的状态表达集中在 `tools/contracts.ts`。请求 Zod 契约在 `contracts.ts`，持久查询投影在 `rows.ts`，SQL 表定义在各 `schema.ts`；`events.ts` 保存事件并调用推送，`tools/actions.ts` 复用持久工具结果。
- `agents/`：Agent 身份、资料、创建与目录；`http.ts` 注册 Agent 和模型供应商入口；供应商模型的校验仍在控制面，不能带进浏览器。
- `runtime/`：从 `runs/coordinator.ts` 的 `start`、`drain`、`advance` 阅读运行装配；`advance` 为 `AgentLoop.run` 提供 `isCurrent`、`appendSessionEntry`、`executeTool` 三项具名能力。`loop.ts` 持有短暂 Pi 对象，用 `streamNormalResponse`、`transformModelContext`、`persistAgentEvent` 表达响应请求、上下文转换和会话事件写入。协调器拥有唯一 active map、调度、消息提示和取消；`runs/records.ts` 保存候选准入、上下文边界、完成、失败、退避与重启恢复，`runs/control.ts` 组织人工暂停、命令停止及收据、恢复和环境核验。`session/service.ts` 用具名 run/node/Agent 身份写入完整历史，共用 `SessionMessageRow` 和 `projectContextMessage` 表达读取投影；`session/compaction.ts` 的摘要输入明确区分已有摘要和分割轮次前缀。`tools/registry.ts` 组合工具目录，集中发现、调用和当前 run 检查。进程账本与更正在 `processes/operations.ts`，恢复输入在 `recovery/context.ts`，供应商响应的结束和用量证据在 `provider-response.ts`；SQL 表定义放在相应能力的 schema。
- `workspaces/`：从 `http.ts` 的具名请求沿 `WorkspaceService.reads`、`downloads` 找到 owner 浏览、分块和下载入口；`service.ts` 组装读取、变更、下载能力，组合 Agent 工具并关闭资源。`reads/service.ts` 拥有 owner/Agent/附件发布读取，`reads/file-content.ts` 解释字节类型与 UTF-8 范围，`reads/image-result.ts` 表达图片工具结果。`actions/service.ts` 连续表达文件变更步骤，`actions/ledger.ts` 保存意图、结果和迟到收据；`downloads/service.ts` 拥有有界流与下载状态。共享节点结果适配和访问记录在 `access/service.ts`，读取结果校验在 `results.ts`，数据契约与工具请求分别在 `contracts.ts` 和 `tool-contracts.ts`。
- `attachments/`：从 `service.ts` 找到 owner 上传、列表、文本读取、下载和工具组合；Agent 发布直接由 `publication.ts` 表达完整用例，只接收 `WorkspaceReads.readForAgentPublish`。`access.ts` 表达对话读取、成员发布和 owner 权限，`rows.ts` 负责附件行投影与上传中记录，`schema.ts` 定义附件元数据表；文件流、名称和存储路径在 `storage.ts`，发布结果解析在 `results.ts`。
- `nodes/`：`directory.ts` 拥有 socket 生命周期、当前连接、心跳、在线列表与消息分派，并组合 `identity` 和 `operations` 能力。配对令牌、签名与节点账号直接从 `identity.ts` 进入，账号记录参加调用方事务；Agent 工作区准备、文件操作和进程操作直接从 `operations.ts` 进入，准备请求用具名输入区分节点、请求、Agent 和核验模式。`pending-requests.ts` 管理等待中的 Promise 与计时器，`reconciliation.ts` 表达进程、文件收据的分页核对；`transport.ts` 定义 socket/session 及发送、拒绝消息。
- `auth/`：所有者登录。`providers/credentials.ts` 保存模型凭据，`catalog.ts` 提供供应商与模型目录；`active-check.ts` 的 `streamCheckResponse` 和 `observeCheckEvent` 分别表达主动协议检查的请求与观察。`notifications/push.ts` 拥有网页推送 outbox，`queue` 用具名事件键、标题和目标入队，实际 Web Push 发送在 `sendNotification`。
- `storage/`：数据库初始化与各领域表的装配。领域里的 `schema.ts`、`*-schema.ts` 是 SQL 表定义，与 Zod 的 `contracts.ts` 分工不同。

没有为了缩短文件而引入通用仓储层，也没有把事务拆成通过庞大上下文对象相互调用的小函数。跨领域操作仍应能看清在哪个事务里提交。

## 从一次操作追到证据

- Owner 发消息：`conversations/http.ts` → `chat.messages.createMessage`（原子保存消息/投递）→ `runs.wake/drain`（准入同一 Agent 的唯一 current run）→ `AgentLoop.run` → `AgentSession` 的原 session 历史与 Pi 请求。
- 模型用工具：`runtime/tools/registry.ts` 在工具入口事务内复验 current run；任务/提醒等同步效果在这个事务里完成。文件变更/命令工具先保存 node 意图；文件读取无需变更意图。两者都等待入口事务提交，再复验 current run 并调用 node。文件结果进 `WorkspaceActionLedger`，命令结果进 `AgentProcessOperationBroker`；`recovery/context.ts` 把后来的证据送回原 session。
- 文件读取：owner 路由使用 `workspace.reads`，Agent 工具由 `WorkspaceService.agentTools()` 组合；两者进入 `WorkspaceReads`，经 `WorkspaceAccess` 和 `nodes.operations` 请求节点，再由 `LinuxWorkspaceExecutor`、同账号 helper 与 `reads/file-content.ts`/`reads/image-result.ts` 返回字节或模型内容。
- node 恢复：`connection/node-client.ts` 重连 → `NodeDirectory` 验证连接身份 → 先 process、再 workspace 分页核对 → 标为 ready → 原 Agent 队列继续。未确认的副作用保持 unknown，不因重连重放。

| 身份或状态 | 生命周期与作用 |
| --- | --- |
| sessionId | Agent 的持久逻辑上下文，跨 run/频道/线程继续 |
| runId | 一次工作轮次；current run 资格决定工具请求能否生效 |
| deliveryId | 某消息给某 Agent 的持久注意力投递；handled 不等于任务完成 |
| actionId | 原 session 中的模型工具调用身份，复用已保存的工具结果 |
| operationId | node 副作用的稳定身份，跨临时请求和重启查证据；文件由 actionId 确定性生成 |
| requestId | node 请求/回复关联；一般 RPC 等待是内存状态，Agent 创建的 provision_request_id 则持久保存并在失败重试时复用；与副作用 operationId 分工不同 |
| requestHash / nodeRequestHash | 分别校验工具输入、node 操作参数是否与原意图一致；不能当作 operationId |
| receipt revision / file version | 前者是同一收据的新旧证据；后者是具体文件版本，控制读写一致性 |
| online / ready / unknown | ready 是连接完成启动对账的内部状态；对外 online 同时要求连接身份匹配、ready 和心跳未过期；unknown 表示执行效果尚无确定证据 |

SQLite 的 session/run/交付/动作记录和 node 本地收据是持久事实；pending 请求与短期身份 map 只加速关联，丢失后回查持久记录。固定测试启动器的暂停和合成 provider 只用于验证这些边界，不是生产调度依赖。

## 节点按执行职责找代码

- `connection/`：从 `node-client.ts` 进入身份验证、心跳与重连；`node-identity.ts` 读取或创建节点身份。`process-requests.ts`、`workspace-requests.ts` 分别处理当前连接的操作请求与收据对账。
- `provisioning/`：`agent-workspace.ts` 准备、核验同一运行账号下的 Agent 默认工作区与 MEMORY.md；`workspace-marker.ts` 管理工作区身份标记，`errors.ts` 定义创建失败。
- `files/`：`workspace-executor.ts` 选择读取工作区、执行操作并保存收据；`same-account-files.ts` 启动同账号 helper、收集输出，`workspace-result.ts` 将结果写入协议响应。`file-operation.mts` 按操作种类分派，具名函数表达内容读取、保存与 JSON 输出；`fixed-workspace-paths.ts` 拥有目录描述符与路径检查，缺失路径和父目录创建由具名选项表达。`mutations/` 提供原子重命名与内容核验。`file-failures.ts` 归一具名文件错误和系统 errno；helper 非零退出在 stderr 写有界错误 JSON，backend 解析诊断，错误码随结果和收据传递。
- `processes/`：`operation-runtime.ts` 装配数据库与命令执行器；`operation-ledger.ts` 保存请求和持久收据。`linux-process-executor.ts` 按普通命令、查询和停止操作分派；`ordinary-command.ts` 拥有子进程、输出与跟踪记录，`linux-processes.ts` 提供进程信号和 Linux 状态读取。
- `management/`：完整发布包契约与校验、现有账号目录规则、唯一 CLI 入口安装、私有节点配置和 systemd 用户服务管理；`service/commands.ts` 拥有服务启停/状态命令，`service/systemd.ts` 保留私有 D-Bus 调用，`service/systemd-property.ts` 是其相邻 subprocess helper；`acquire-bundle.ts` 只获取临时完整包，`update.ts` 在停止事实与管理锁内切换，`repair-bundle.ts` 处理可信原清单下的外部 CLI 同版修复；`deploy/node/` 是离线生产包构建、薄 bootstrap 和实际包外部验收入口。见 [完整 node 包说明](node/NODE_BUNDLE.md)、[用户服务说明](node/NODE_SERVICE.md) 与 [停机更新](node/NODE_UPDATE.md)。

节点卸载由 `management/uninstall.ts` 根据实际单元、入口与包库存继续清理，使用同一管理锁并保留配置与数据；命令恢复和真实服务验收入口见 [卸载说明](node/NODE_UNINSTALL.md)。

对应测试也按这些目录组织。外部使用节点时，依赖 package 的明确导出；内部移动文件不要求调用方知道新的磁盘路径。

所有者主动运行的供应商协议检查位于控制面 `providers/active-check.ts`，`active-check-cli.ts` 负责显式模型选择、私密凭据文件和终端取消。它使用现有 Pi 库，独立于 Mate 的持久 Agent/session 和 node；合成 HTTP/SSE 验证在 `tests/providers/check-*.test.ts`。入口与结果含义见 [DEVELOPMENT.md](DEVELOPMENT.md#所有者主动检查真实模型供应商)。

## 真实进程场景辅助代码

`apps/control-plane/tests/support/environment/scenario-environment.ts` 接收结构化服务和 Agent 配置，拥有登录、配对、工作区准备、保留身份的重启、资源登记与尽力清理。`scenario-services.mjs` 是使用本次构建结果的固定测试启动文件；`run-services.ts` 提供真实输出等待、输出游标、取消与有界停进程。模型输出沿用 `agent-loop.ts` 的本地 HTTP/SSE handler 和 `respond`。`scripted-provider.ts` 按 Agent 原 session 关联命名普通函数步骤，负责响应释放、取消与截止时间；`scripted-tool-results.ts` 通过真实调用 ID 读取工具结果并复用领域 schemas。`tests/providers/scripted-agent-routing.test.ts` 包含同 model 双 Agent 交错工具、真实摘要与失败路径探针。`tests/scenarios/environment/startup.test.ts` 从真实 Owner API、模型工具结果和文件字节验证生命周期；新增场景入口与使用边界见 [DEVELOPMENT.md](DEVELOPMENT.md)。

`scenario-driver.ts` 集中读取 Owner 消息、任务、活动与附件，提供带期限和最后事实的条件等待，以及消息/run/当前游标的关联。`scenario-facts.ts` 只读补充 Owner API 没有暴露的 session、run seed 和实际已提交投递关系；业务结果仍由真实工具产生。`tests/scenarios/driver/seed-recovery.test.ts` 先完成旧 run，再用新 Owner 普通消息驱动任务、命令生成文件、附件发布和显式线程回复，核对 Owner 下载与实际工作区字节；同时覆盖旧完成记录、取消、读取停滞、任务/run 分离、提醒和普通消息的实际输入，以及 seed 输入未提交前的中断/恢复。

`scenario-evidence.ts` 用同一环境生命周期包装场景，保留原始失败、清理前的合成证据及释放结果；`scenario-cleanup.mjs` 提供驱动 SIGKILL 后的独立、归属核验回收入口。`tests/scenarios/evidence/assertions-cleanup.test.ts` 是短真实文件成果、失败／取消／再运行的使用样例。文件目录可直接作 CI artifact，操作方式见开发说明的“场景失败证据与独立回收”。

`tests/scenarios/report-workflow.ts` 是完整正常工作样例：甲从 Owner 普通请求创建／认领任务、真实生成草稿，经 peer DM 附件让乙独立复核，乙真实反馈后甲继续原 session 的第二轮并交付最终报告。它同时保留模型脚本与任务、消息路由、文件／附件字节、session／run 断言，供现有环境的其它拓扑复用；`tests/scenarios/report-workflow.test.ts` 只装配同一 `runScenario` 入口。开发说明的“新增正常工作场景”展示短单 Agent 写法和完整样例入口。

`tests/files/command-crash-recovery.test.ts` 补充命令 start 后执行前／效果后收据前的真实 node SIGKILL 与恢复后的主动效果检查。`scenario-command-boundary.mjs` 只在固定测试启动文件注入既有真实 ledger/executor，暂停可释放、取消并有期限；`scenario-command-facts.ts` 在既有只读事实投影上解析命令身份、收据和实际模型可见的更正。收据已持久化后失效／对账继续复用 `tests/tools/recovery/invalidation.test.ts` 的命令用例；覆盖映射与运行入口见开发说明的“真实命令的 node 崩溃与收据边界”。

`scenario-network.ts` 只控制环境主 node 的原始 TCP 链路，提供立即断开、双向静默丢帧、明确恢复和带游标／期限的帧观察；它不回复心跳。`scenario-network-facts.ts` 集中读取 Owner API 没有暴露的提醒投递与待处理队列。`tests/scenarios/node-network-recovery.ts` 保留可复用的普通请求断网／接续脚本与断言；`tests/nodes/node-network.test.ts` 还覆盖实际摘要、离线队列、人工暂停、独立在线节点和观察取消。网络事件沿现有失败证据与环境清理入口保存。

`tests/scenarios/recovery/` 按已提交历史、压缩和命令暂停分组，覆盖既有 CP 提交、任务收据、压缩、部分 SSE 与 SIGTERM 恢复，使用同一场景 ID/证据机制。`tests/scenarios/cp-restart.ts` 保留选定提交后重启场景的模型和成果断言供容器复用；`scenario-recovery-facts.ts` 集中只读补充原 session/run、完整提交与收据事实，Owner API 和实际模型请求仍为主要证据。固定测试启动器仅注入既有提交钩子及 Pi 参数 delta 观测；具体边界与入口见开发说明的“控制面提交与重启恢复场景”。

## 网页按用户功能找代码

下面的功能目录都位于 `apps/web/src/features/`。

- `conversations/`：`chat-page.tsx` 保留唯一频道选择/ref、认证、提交/draft/busy、回复目标、移动视图与 DOM 通知滚动。`feed/use-conversation-feed.ts` 拥有 snapshot/SSE、频道目录、历史窗口与 older/latest/通知 context 数据流，接收频道选择值、具名回调，以及 thread 提供的 `receiveStreamReply`、`installThread` 两个动作。`feed/use-conversation-thread.ts`、`use-conversation-attachments.ts`、`use-owner-push.ts` 分别提供讨论串、附件与点击通知流程；`owner-request.ts` 处理对话请求及带 HTTP 状态的错误。`ui/` 放频道导航、时间线、讨论串、受控 composer、频道弹窗与唯一消息任务表单；各位置/key 不变。`styles/` 的 shell→conversation→dialog→mobile→message-details 由页面固定顺序导入，保留共享选择器和原移动级联；无转发桶或镜像 selection。
- `agents/`：`agents-page.tsx` 保留唯一创建 draft、submitting、页面级私信/邀请互斥和错误，以及 Agent 行展示。`agent-requests.ts` 的 `readAgentDirectory` 并行读取六类目录；`data/use-agent-directory.ts` 拥有目录状态、轮询与 refresh，并把 nodes/providers 交给页面回调整理表单选择。`data/use-model-credentials.ts` 拥有凭据表单状态、提交与撤销动作。`ui/agent-creation-form.tsx` 与 `model-credentials-form.tsx` 是受控完整表单；已有 Editor、Activity 和 stop-status 按展示归入 `ui/`，不增加行包装或局部请求状态。
- `workspace/`：工作区浏览、下载操作及状态查询。
- `nodes/`、`tasks/`、`reminders/`：相应管理页面。

页面和相关样式放在同一功能目录。`apps/web/src/http-json.ts` 共享 JSON 提交、容错响应读取和错误文案提取；领域请求分别表达资料读取的取消信号、对话 HTTP 错误状态、工作区错误码和连接时间。跨请求的取消、过期响应和重新连接由各功能的状态管理。

## 数据契约如何共用

Zod schema 是需要运行时校验的领域数据的类型来源。`z.infer` 或 `z.output` 表示解析后的值；带默认值或转换的输入使用 `z.input`。本地临时值和简单实现函数优先使用推导，模块接口和需要约束的公共形状保留显式类型。

浏览器使用 `@mate/protocol/owner` 和 `@mate/protocol/workspace`，避免依赖含 Node 专用校验的根导出或供应商 SDK。网页只需要静态形状时使用 `import type`；HTTP 和事件流响应需要实际校验时，使用这些浏览器安全的 Zod 契约及保留额外字段的显示投影。运行时校验会引入 Zod，但不应引入 Node 专用工具或模型 SDK。

从调用方的 import 选择契约入口：

| 公开入口 | 定义与阅读路线 |
| --- | --- |
| `@mate/protocol` | `packages/protocol/src/index.ts` 明确列出控制面与节点共用的消息、操作和错误。`messages.ts` 先定义工作区身份、结果、收据和操作模式，再组成 `NodeRequestSchema` 与 `NodeControlMessageSchema`。 |
| `@mate/protocol/owner` | `owner.ts` 定义所有者 HTTP 与事件流的完整资料，如 `ownerMessageSchema` / `OwnerMessage`、`agentSummarySchema` / `AgentSummary`。网页各功能的 `*-responses.ts` 从这里推导屏幕需要的投影。 |
| `@mate/protocol/workspace` | `workspace.ts` 定义文件版本、目录页、文件块和下载状态；控制面、节点和网页共用这些形状。 |
| `@mate/protocol/node` | `node.ts` 计算工作区与进程操作请求摘要，使用 Node 的加密库。 |

工作区操作使用 `workspaceOperationSchema` / `WorkspaceOperation`，进程操作使用 `agentProcessOperationSchema` / `AgentProcessOperation`；两者分别定义于 `workspace-operations.ts` 和 `process-operations.ts`。需要工作区操作的未解析输入时，使用 `z.input<typeof workspaceOperationSchema>`，解析后的 `WorkspaceOperation` 已含分页默认值。控制面节点账号类型直接从 `AgentWorkspaceIdentity` 选取账号字段，无需再从 schema 重复推导同一资料。

数据库查询的参数和行类型写在查询边界；对不可信持久数据或外部结果使用已有 Zod 契约或明确的类型收窄。不要靠 `as` 跳过检查，也不要为了消除一个断言而发明通用框架。

Pi 会话保留供应商扩展字段。会话边界的窄适配不能改成会删掉未知字段的重新构造；变更 Zod schema 时也必须保留原本的严格或宽松行为、默认值、错误映射和恢复含义。

控制面容器交付位于 `deploy/control-plane`：`Dockerfile` 生成生产镜像，`compose.yaml` 仅运行控制面，`compose.initialize.yaml` 只供首次密码初始化，`entrypoint.mjs` 检查普通账号与私有挂载，`build.mjs` 和 `verify.mjs` 是明确版本本地构建及隔离接口验收入口。

真实文件崩溃场景在 `tests/files/recovery/crash-boundaries.test.ts`，复用同一环境、脚本 provider、驱动与失败证据。固定启动器的 `scenario-file-boundary.mjs` 通过 `@mate/node/workspace-execution` 和 `@mate/node/same-account-files` 的明确导出，只包住真实 `LinuxWorkspaceExecutor` 和 `SameAccountFileBackend` 的执行／收据边界，记录带实际操作身份的事件；无生产故障开关。`scenario-file-facts.ts` 校验现有只读动作投影、模型真正收到的收据更正与文件版本。原 `tests/tools/recovery/invalidation.test.ts` 的文件路径继续覆盖断链与收据对账，并核对可变 requestId 和稳定 operation／Agent／请求摘要。

文件启动器用 `AsyncLocalStorage` 保留每个真实请求的身份，使并发 Agent 的文件完成不会错归目标收据边界。双 Agent 回归用有界的首个执行暂留验证这个观察契约；会话事实投影也用于核对原 run 已提交的调用及崩溃前完整模型输入前缀。

交付拓扑的测试适配在 `tests/support/environment/scenario-container.ts`，由同一 `scenario-environment.ts` 的 `container: { image }` 配置选择；测试 override 只存在于场景合成目录。`tests/container/run.mjs` 使用 B 原构建入口创建当前 SHA 的唯一镜像，`delivered-scenarios.integration.ts` 复用正常 workflow 与两个选定恢复导出，并验证驱动 SIGKILL 后的独立回收。生产交付文件不导入这些测试代码；完整入口、实际证据与未验证边界见开发说明。

`deploy/tests/delivery-smoke.sh` 从实际完整包启动独立镜像/Compose 联通验收；`delivery.mjs` 只用 Node 内置库，经所有者 API 与真实 Pi/节点检查程序和数据，`control-plane-fixture.mjs` 仅在测试 override 注入合成模型 HTTP/SSE 地址。生产配置不导入这些测试文件。真实四平台用户服务命令与证据边界见 [部署验收](DEPLOYMENT_ACCEPTANCE.md)。

机器端 `connection/node-client.ts` 拥有认证、心跳、重连和 socket 生命周期；`process-requests.ts` 与 `workspace-requests.ts` 各自拥有完整操作及收据对账。发送能力绑定发起请求的原 socket；关闭不取消已经执行的副作用，也不把结果转给新的连接。两类原 Promise 错误处理分别保留。

机器端 `files/file-operation.mts` 保留实际 worker、操作分派和原错误输出位置；`fixed-workspace-paths.ts` 拥有固定目录描述符、路径核验、短变更锁和逐个释放。`files/mutations/` 集中原子 rename 及基于哈希的完整提交/移动；worker 与 native helper 的实际位置不变。`provisioning/agent-workspace.ts` 保留 MEMORY 初始化及同 Agent 互斥，`workspace-marker.ts` 拥有标记的完整创建、验证和崩溃恢复，共享错误单向来自 `errors.ts`。

## Agent 文件读取的内容边界

文件与附件读取先探测同一版本至多 8 KiB 的前缀，再检查请求范围。PNG/JPEG/GIF/WebP 按固定字节签名判断；文本使用严格 UTF-8 和控制字符检查。有限探测不保证识别所有未知二进制，也不检查图片内部编码损坏。完整文件系统图片通过节点有界分块读取，最大 5 MiB；短读、版本变化和超过上限均不能成为图片内容块。请求中的模型须明确声明图片输入能力。上传图片或二进制始终只给类型提示，上传文本继续可读；Mate 不安装转换程序。

文本范围为完整 UTF-8 字符在两端各最多多读 3 字节。`requestedOffset`/`requestedLength` 保留请求，`offset`/`nextOffset` 给出实际文本字节范围（右端不包含）；使用 `nextOffset` 继续，文件系统读取同时传回原 `version`。图片持久化为 Pi 内容块；纯文本模型与压缩请求将其投影为提示，不修改原始 transcript。

## 测试目录按能力组织

控制面 `tests/` 下的 `http`、`conversations`、`tasks`、`agents`、`session`、`tools`、`runs`、`nodes` 和 `files` 对应现有能力；`scenarios` 保留完整工作和恢复场景。浏览器测试使用同样的功能词汇，组件测试和 HTTP/事件响应契约测试分别放在功能目录和 `contracts`。Vitest 递归发现这些目录，无需维护测试文件清单。

控制面的小型准备入口按用途命名：`createAgentCreationFixture` 提供创建资料的应用，`createConversationFixture` 提供已登录并配对节点的对话环境，`createAgentToolFixture` 和 `createProcessToolFixture` 分别提供工具与进程调用环境。网页 `tests/support/chat-fixture.ts` 与 `agents-fixture.ts` 用普通工厂创建有初值的数据，复用已有协议投影；测试直接调整数据、调用页面，再观察断言，HTTP 回复使用原生 `Response`。

`apps/control-plane/benchmarks/tool-action.mjs` 先准备固定合成历史，再测量既有动作读取；`syntheticMessage` 与 `actionIdentity` 分别表达历史内容和目标位置。`docs/research/pi-compaction-prefix-probe.mjs` 是不发送网络请求的自有序列化探针，`captureRequestPayload` 读取请求形状，`withoutCacheMarkers` 表达比较时略去的缓存标记。

共享环境位于控制面 `tests/support/`：`agent` 装配合成 Agent/模型和套接字，`node` 观察进程与连接，`provider` 模拟传输协议，`facts` 解析只读持久证据，`scenario` 提供场景驱动与失败证据，`environment` 管实际服务启动、配置和资源清理。大型场景按能力拆成完整用例，各套件显式注册自己的清理；没有兼容转发目录。`ScenarioResources` 在服务还存在时先收集证据，再逆序释放资源；失败的释放仍可在下一次 close 重试，超时不会重复发起正在进行的释放。

本轮整理后保留的测试文件尺寸例外如下；这些是具体取舍，不是目录或行数的 CI 豁免规则。

| 文件 | 保留在一起的原因 |
| --- | --- |
| `tests/tools/recovery/invalidation.test.ts`（740 行） | 一个 16 组合参数矩阵连续观察同一份 held wire 回包、旧 run、node 持久收据、恢复模型输入与效果次数。按暂停/凭据/断链/重启拆文件会复制主要断言；把各阶段分成接受可变上下文的 helper 会隐藏实际时序。 |
| `tests/support/environment/scenario-environment.ts`（519 行） | 配置与重试清理已经移出。余下闭包拥有同一组服务实例、认证 cookie、启动取消与重启互斥；启动/重启必须更新同一实例供请求和清理读取。再拆需要暴露可变服务引用或第二套生命周期。 |
| `tests/linux/single-account-node.integration.mjs`（517 行） | 一次普通账号下真实控制面/节点/普通命令的完整生命周期验收，最后的统一清理覆盖每个提前失败。只超出少量行，拆成阶段函数会增加远程进程和目录状态传递。 |
| `deploy/tests/delivery.mjs`（628 行） | 一个完整离线包与 Compose 交付验收，镜像/服务/临时目录归属和统一 finally 在同一次运行中核验。每个阶段依赖实际前一阶段产生的包和持久身份；拆分为多条测试会改变同包接续证据，抽象资源袋收益不足。 |

## 仓库根目录的必要尺寸例外

排除两份锁文件后，仓库根目录有 11 个直接文件。`.dockerignore`、`.gitignore`、`.nvmrc`、`.prettierignore`、`.prettierrc.json`、`package.json`、`pnpm-workspace.yaml` 和 `tsconfig.json` 是现有工具从根目录使用的八个入口；`README.md`、`AGENTS.md` 和 `CONTEXT.md` 按项目约定也保留在根目录。只为少一个文件而新建配置目录，会增加工具路径配置与首次阅读成本，本轮保留这些实际入口。

节点包、用户服务、更新与卸载四篇指南完整归在 `docs/node/`，运行步骤仍从 [OPERATIONS.md](OPERATIONS.md) 进入；不增加索引副本或转发页。目录和代码行数是设计默认值，没有新增尺寸 CI 门禁。
