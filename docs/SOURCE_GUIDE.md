# 源码导航与类型约定

第一次接触 Mate，可以先看下面的入口，再沿实际请求走向阅读。产品概念以根目录 `CONTEXT.md` 为准，运行和检查命令见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 四个 package

| 位置 | 负责什么 | 建议从哪里开始 |
| --- | --- | --- |
| `apps/web` | 所有者使用的中文网页 | `src/main.tsx`，然后进入相应功能目录 |
| `apps/control-plane` | 登录、持久状态、会话和工具循环、调度与请求路由 | `src/main.ts` 装配，`src/http.ts` 装配服务、明确启动协调器并注册领域 HTTP 入口 |
| `apps/node` | 机器连接、Agent 工作区、文件与命令执行、本地收据 | `src/main.ts`，然后看 `src/connection/node-client.ts` |
| `packages/protocol` | 跨 package 的运行时数据契约及其推导类型 | `src/owner.ts`、`src/workspace.ts` 和节点消息、操作契约 |

控制面拥有模型循环，节点不运行模型。一次 run 结束也不表示消息关联的任务已经完成。

## 控制面按领域找代码

- `conversations/`：`service.ts` 装配共享数据库/时钟下的既有 OwnerChat 公共入口，保留同一读事务内的 snapshot 与工具目录组合；下层不依赖整个 OwnerChat。`channels/directory.ts` 管 Owner/peer DM、频道事实和 read/member 授权，`channels/membership.ts` 管频道 CRUD、加入与邀请并单向依赖目录。`messages/timeline.ts` 管消息分页、讨论串和读取正文后的 presented 标记；`messages/attention.ts` 管注意力、消息草稿和发送新鲜度；`messages/writer.ts` 保存消息及迟到收据更正，`messages/deliveries.ts` 管当前成员快照、pending/handled 和 run 完成。`tasks/service.ts` 管任务认领及任务草稿，`tasks/reminders.ts` 集中提醒 CRUD、到期持久投递与 handled 同步；提醒保持专用单接收者投递。`events.ts` 在原事务位置保存事件和调用原 push 回调；`tools/actions.ts` 复用持久工具结果，`tools/contracts.ts` 保留 Zod 工具定义及输入推导。`contracts.ts`、`rows.ts`、`schema.ts` 和 `http.ts` 分别负责请求校验、持久查询投影、表装配及领域 HTTP 入口。
- `agents/`：Agent 身份、资料、创建与目录；`http.ts` 注册 Agent 和模型供应商入口；供应商模型的校验仍在控制面，不能带进浏览器。
- `runtime/`：`runs/coordinator.ts` 构造时只收依赖，工厂显式 `start()` 启动恢复与调度；`close()` 在关闭 node 和数据库前取消运行。`runs/coordinator.ts` 拥有唯一 active map、调度/消息提示、模型推进和取消；`runs/records.ts` 拥有候选准入、上下文边界、完成/失败/退避与重启恢复；`runs/control.ts` 拥有人工暂停、命令停止及收据、恢复和环境核验。暂停提交后由协调器取消再派发，恢复激活后立即 wake；关闭检查继续使用同一窄能力。`processes/operations.ts` 保留完整进程账本与更正，`recovery/context.ts` 只组织恢复输入；SQL 表定义放在相应能力的 schema。`session/` 管完整历史和压缩，`tools/` 管工具入口和当前 run 检查；`provider-response.ts` 只解释供应商响应中的结束和用量证据。
- `workspaces/`：`service.ts` 装配既有公开入口和工具组合；`access/service.ts` 集中节点结果/错误适配、owner 工作区可用性和不含正文的访问审计。`reads/service.ts` 拥有 owner/Agent/发布读取，`reads/file-content.ts` 解释有界字节和 UTF-8 范围，`reads/image-result.ts` 保留图片工具结果；普通 Agent 读取在 node 请求前后复验 run，发布读取仍由附件最终提交复验。`actions/service.ts` 保留 prepare→等待 committed→track→复验→node→complete/unknown 的完整变更流程，`actions/ledger.ts` 拥有持久意图、结果及迟到收据更正，不自动重放未知副作用。`downloads/service.ts` 拥有有界流、session 绑定、24h 状态保留、启动恢复与计时器；每次 owner stat/chunk 仍独立审计。`contracts.ts` 和 `results.ts` 保留各自原有契约/解析条件，稳定文件失败码来自 protocol `workspace-failures.ts`，旧结果适配与 unknown 前缀规则不变。
- `attachments/`：`service.ts` 保留 owner 上传、附件读取、重启恢复和工具组合；`publication.ts` 完整拥有 Agent 文件发布，只依赖工作区发布读取能力。首个 await 前同步 reservation/uploading；最后一次 stat 和原 hook 后，在原事务内复验 run、rename/fsync、保存 ready 与成功收据。`access.ts` 分别保留 public/member/owner 三种权限；`rows.ts` 保存共享行投影及上传中记录，`storage.ts` 保存私有安全路径和有界流函数，无通用存储层。
- `nodes/`：`directory.ts` 拥有 socket 生命周期、当前连接、心跳、在线状态、消息分派和装配。`identity.ts` 拥有持久配对身份、令牌/签名及账号记录，账号记录继续参加调用方事务；`operations.ts` 拥有三种完整请求的身份、超时和结果，`pending-requests.ts` 只管理 Promise 与计时器。`reconciliation.ts` 保留进程→文件→ready 的持久分页与缺失/冲突收据处理，只查询在途身份并传递领域结果；`transport.ts` 是共享 socket/session 类型和无状态发送/拒绝。断线与迟到 process/workspace 收据仍进入原更正入口，未知副作用不自动重放。
- `auth/`、`providers/`、`notifications/`：所有者登录、模型凭据和供应商目录、网页推送。
- `storage/`：数据库初始化与各领域表的装配。领域里的 `schema.ts`、`*-schema.ts` 是 SQL 表定义，与 Zod 的 `contracts.ts` 分工不同。

没有为了缩短文件而引入通用仓储层，也没有把事务拆成通过庞大上下文对象相互调用的小函数。跨领域操作仍应能看清在哪个事务里提交。

## 从一次操作追到证据

- Owner 发消息：`conversations/http.ts` → `OwnerChat.createMessage`（原子保存消息/投递）→ `runs.wake/drain`（准入同一 Agent 的唯一 current run）→ `AgentLoop.run` → `AgentSession` 的原 session 历史与 Pi 请求。
- 模型用工具：`runtime/tools/registry.ts` 在工具入口事务内复验 current run；任务/提醒等同步效果在这个事务里完成。文件变更/命令工具先保存 node 意图；文件读取无需变更意图。两者都等待入口事务提交，再复验 current run 并调用 node。文件结果进 `WorkspaceActionLedger`，命令结果进 `AgentProcessOperationBroker`；`recovery-context.ts` 把后来的证据送回原 session。
- 文件读取：`WorkspaceService` 装配 → `WorkspaceReads` 验证范围并通过 `WorkspaceAccess` 请求 node → `LinuxWorkspaceExecutor` 与同账号 helper → `reads/file-content.ts`/`reads/image-result.ts` 解释有限字节；变更先保存意图并等待提交，再调用 node 和记录收据终态。
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

- `connection/`：节点身份、配对、WebSocket 连接及重连。
- `provisioning/`：准备同一运行账号下的 Agent 默认工作区。
- `files/`：文件操作入口、辅助进程、路径检查与原子文件操作。`file-failures.ts` 归一具名文件错误和系统 errno；helper 非零退出在 stderr 写有界错误 JSON，backend 解析并保留诊断，新 code 随结果和收据传递，成功 stdout 保持原格式。
- `processes/`：普通命令、进程状态、操作运行与持久收据。
- `management/`：完整发布包契约与校验、现有账号目录规则、唯一 CLI 入口安装、私有节点配置和 systemd 用户服务管理；`acquire-bundle.ts` 只获取临时完整包，`update.ts` 在停止事实与管理锁内切换，`repair-bundle.ts` 处理可信原清单下的外部 CLI 同版修复；`deploy/node/` 是离线生产包构建、薄 bootstrap 和实际包外部验收入口。见 [完整 node 包说明](NODE_BUNDLE.md)、[用户服务说明](NODE_SERVICE.md) 与 [停机更新](NODE_UPDATE.md)。

节点卸载由 `management/uninstall.ts` 根据实际单元、入口与包库存继续清理，使用同一管理锁并保留配置与数据；命令恢复和真实服务验收入口见 [卸载说明](NODE_UNINSTALL.md)。

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

- `conversations/`：`chat-page.tsx` 保留唯一频道选择/ref、认证、提交/draft/busy、回复目标、移动视图与 DOM 通知滚动。`feed/use-conversation-feed.ts` 拥有 snapshot/SSE、频道目录、历史窗口与 older/latest/通知 context 数据流，使用同一 ref 检查迟到响应；thread 能力解构为稳定函数，避免重开 SSE。`feed/use-conversation-thread.ts`、`use-conversation-attachments.ts`、`use-owner-push.ts` 各自保留原讨论串、附件与点击通知流程。`ui/` 放频道导航、时间线、讨论串、受控 composer、频道弹窗与唯一消息任务表单；各位置/key 不变。`styles/` 的 shell→conversation→dialog→mobile→message-details 由页面固定顺序导入，保留共享选择器和原移动级联；无转发桶或镜像 selection。
- `agents/`：`agents-page.tsx` 保留唯一创建 draft、submitting、页面级私信/邀请互斥和错误，以及 Agent 行展示。`data/use-agent-directory.ts` 拥有六类目录、轮询与 refresh；本次 nodes/providers 通过稳定回调按原顺序对账 provider/draft，异常吞并和 abort 保持。`data/use-model-credentials.ts` 的凭据状态仍常驻页面，busy 覆盖显式 refresh。`ui/agent-creation-form.tsx` 与 `model-credentials-form.tsx` 是受控完整表单；已有 Editor、Activity 和 stop-status 按展示归入 `ui/`，不增加行包装或局部请求状态。
- `workspace/`：工作区浏览、下载操作及状态查询。
- `nodes/`、`tasks/`、`reminders/`：相应管理页面。

页面和相关样式放在同一功能目录。共享登录和请求处理保持独立；跨请求的取消、过期响应和重新连接仍由原有状态边界管理。

## 数据契约如何共用

Zod schema 是需要运行时校验的领域数据的类型来源。`z.infer` 或 `z.output` 表示解析后的值；带默认值或转换的输入使用 `z.input`。本地临时值和简单实现函数优先使用推导，模块接口和需要约束的公共形状保留显式类型。

浏览器使用 `@mate/protocol/owner` 和 `@mate/protocol/workspace`，避免依赖含 Node 专用校验的根导出或供应商 SDK。网页只需要静态形状时使用 `import type`；HTTP 和事件流响应需要实际校验时，使用这些浏览器安全的 Zod 契约及保留额外字段的显示投影。运行时校验会引入 Zod，但不应引入 Node 专用工具或模型 SDK。

数据库查询的参数和行类型写在查询边界；对不可信持久数据或外部结果使用已有 Zod 契约或明确的类型收窄。不要靠 `as` 跳过检查，也不要为了消除一个断言而发明通用框架。

Pi 会话保留供应商扩展字段。会话边界的窄适配不能改成会删掉未知字段的重新构造；变更 Zod schema 时也必须保留原本的严格或宽松行为、默认值、错误映射和恢复含义。

控制面容器交付位于 `deploy/control-plane`：`Dockerfile` 生成生产镜像，`compose.yaml` 仅运行控制面，`compose.initialize.yaml` 只供首次密码初始化，`entrypoint.mjs` 检查普通账号与私有挂载，`build.mjs` 和 `verify.mjs` 是明确版本本地构建及隔离接口验收入口。

真实文件崩溃场景在 `tests/files/recovery/crash-boundaries.test.ts`，复用同一环境、脚本 provider、驱动与失败证据。固定启动器的 `scenario-file-boundary.mjs` 通过 `@mate/node/workspace-execution` 和 `@mate/node/same-account-files` 的明确导出，只包住真实 `LinuxWorkspaceExecutor` 和 `SameAccountFileBackend` 的执行／收据边界，记录带实际操作身份的事件；无生产故障开关。`scenario-file-facts.ts` 校验现有只读动作投影、模型真正收到的收据更正与文件版本。原 `tests/tools/recovery/invalidation.test.ts` 的文件路径继续覆盖断链与收据对账，并核对可变 requestId 和稳定 operation／Agent／请求摘要。

文件启动器用 `AsyncLocalStorage` 保留每个真实请求的身份，使并发 Agent 的文件完成不会错归目标收据边界。双 Agent 回归用有界的首个执行暂留验证这个观察契约；会话事实投影也用于核对原 run 已提交的调用及崩溃前完整模型输入前缀。

交付拓扑的测试适配在 `tests/support/environment/scenario-container.ts`，由同一 `scenario-environment.ts` 的 `container: { image }` 配置选择；测试 override 只存在于场景合成目录。`tests/container/run.mjs` 使用 B 原构建入口创建当前 SHA 的唯一镜像，`delivered-scenarios.integration.ts` 复用正常 workflow 与两个选定恢复导出，并验证驱动 SIGKILL 后的独立回收。生产交付文件不导入这些测试代码；完整入口、实际证据与未验证边界见开发说明。

`deploy/tests/delivery-smoke.sh` 从实际完整包启动独立镜像/Compose 联通验收；`delivery.mjs` 只用 Node 内置库，经所有者 API 与真实 Pi/节点检查程序和数据，`control-plane-fixture.mjs` 仅在测试 override 注入合成模型 HTTP/SSE 地址。生产配置不导入这些测试文件。真实四平台用户服务命令与证据边界见 [部署验收](DEPLOYMENT_ACCEPTANCE.md)。

## Agent 文件读取的内容边界

文件与附件读取先探测同一版本至多 8 KiB 的前缀，再检查请求范围。PNG/JPEG/GIF/WebP 按固定字节签名判断；文本使用严格 UTF-8 和控制字符检查。有限探测不保证识别所有未知二进制，也不检查图片内部编码损坏。完整文件系统图片通过节点有界分块读取，最大 5 MiB；短读、版本变化和超过上限均不能成为图片内容块。请求中的模型须明确声明图片输入能力。上传图片或二进制始终只给类型提示，上传文本继续可读；Mate 不安装转换程序。

文本范围为完整 UTF-8 字符在两端各最多多读 3 字节。`requestedOffset`/`requestedLength` 保留请求，`offset`/`nextOffset` 给出实际文本字节范围（右端不包含）；使用 `nextOffset` 继续，文件系统读取同时传回原 `version`。图片持久化为 Pi 内容块；纯文本模型与压缩请求将其投影为提示，不修改原始 transcript。

## 测试目录按能力组织

控制面 `tests/` 下的 `http`、`conversations`、`tasks`、`agents`、`session`、`tools`、`runs`、`nodes` 和 `files` 对应现有能力；`scenarios` 保留完整工作和恢复场景。浏览器测试使用同样的功能词汇，组件测试和 HTTP/事件响应契约测试分别放在功能目录和 `contracts`。Vitest 递归发现这些目录，无需维护测试文件清单。

共享环境位于控制面 `tests/support/`：`agent` 装配合成 Agent/模型和套接字，`node` 观察进程与连接，`provider` 模拟传输协议，`facts` 解析只读持久证据，`scenario` 提供场景驱动与失败证据，`environment` 管实际服务启动、配置和资源清理。大型场景按能力拆成完整用例，各套件显式注册自己的清理；没有兼容转发目录。`ScenarioResources` 在服务还存在时先收集证据，再逆序释放资源；失败的释放仍可在下一次 close 重试，超时不会重复发起正在进行的释放。

本轮整理后保留的测试文件尺寸例外如下；这些是具体取舍，不是目录或行数的 CI 豁免规则。

| 文件 | 保留在一起的原因 |
| --- | --- |
| `tests/tools/recovery/invalidation.test.ts`（740 行） | 一个 16 组合参数矩阵连续观察同一份 held wire 回包、旧 run、node 持久收据、恢复模型输入与效果次数。按暂停/凭据/断链/重启拆文件会复制主要断言；把各阶段分成接受可变上下文的 helper 会隐藏实际时序。 |
| `tests/support/environment/scenario-environment.ts`（519 行） | 配置与重试清理已经移出。余下闭包拥有同一组服务实例、认证 cookie、启动取消与重启互斥；启动/重启必须更新同一实例供请求和清理读取。再拆需要暴露可变服务引用或第二套生命周期。 |
| `tests/linux/single-account-node.integration.mjs`（517 行） | 一次普通账号下真实控制面/节点/普通命令的完整生命周期验收，最后的统一清理覆盖每个提前失败。只超出少量行，拆成阶段函数会增加远程进程和目录状态传递。 |
| `deploy/tests/delivery.mjs`（628 行） | 一个完整离线包与 Compose 交付验收，镜像/服务/临时目录归属和统一 finally 在同一次运行中核验。每个阶段依赖实际前一阶段产生的包和持久身份；拆分为多条测试会改变同包接续证据，抽象资源袋收益不足。 |
