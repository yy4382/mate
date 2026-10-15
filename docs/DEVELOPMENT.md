# 本地开发与验证

生产只有控制面镜像/Compose 与 node 完整包、薄 bootstrap、统一 `mate node` CLI 和 systemd 用户服务路径，见[运维说明](OPERATIONS.md)。下文源码入口用于开发和测试，不是 VPS 的安装方式。

使用 Node 24 和 pnpm 10.33.0。运行 `pnpm install --frozen-lockfile`、`pnpm check`、`pnpm typecheck`。`pnpm build` 将控制面编译到 `apps/control-plane/dist`、节点编译到 `apps/node/dist`，将网页写入 `apps/web/dist`。节点可单独用 `pnpm build:node` 构建，并通过 `pnpm --filter @mate/node test` 运行本地行为测试。运行环境变量见[配置说明](CONFIGURATION.md)，生产部署与诊断见[运维说明](OPERATIONS.md)。

## 无凭据 PR/main Linux 检查

`.github/workflows/ci.yml` 在 PR 和 main 提交上使用 Ubuntu 24.04 runner、Node 24.21.0（与 `pnpm-workspace.yaml` 一致）、`package.json` 的 pnpm 10.33.0 和冻结锁文件。源码权限为 `contents: read`，Actions 固定到经官方仓库 tag 核验的完整提交；单个作业上限为 30 分钟。干净 checkout 在本地和 CI 使用同一个入口：

```sh
pnpm install --frozen-lockfile
pnpm check:ci
```

`pnpm check:ci` 依次运行 `pnpm check`、`pnpm typecheck`、`pnpm test:linux-single-account-node`、`pnpm test:single-account-agent-workspace`、`pnpm test:linux-ordinary-command-failure` 和 `pnpm test:container-scenarios`，任一步失败都会保留非零结果，没有自动重试。`pnpm check` 的 `test:unit` 名称沿用 package 既有命名，其中已经包含真实控制面/node 子进程、Pi、HTTP/SSE、WebSocket、SQLite、普通命令／文件和完整双 Agent 报告 workflow；CI 不再次运行这整套测试。三个独立脚本不在 `pnpm check` 内，因此由同一入口另行运行。后续普通 Vitest 故障场景加入既有测试目录，自动进入这条入口。

CI 日志记录实际 checkout SHA、内核／平台／架构、运行账号 UID/GID、Node 和 pnpm 版本；PR 默认检查 GitHub 的合并提交，实际 SHA 以日志为准。先前步骤失败或取消时，`always()` 独立步骤仍在两分钟期限内尽力回收 `artifacts/scenarios` 清单所属资源，直接用 Node 执行现有回收器，依赖安装失败也能尝试。清理残留仍使作业失败；SIGKILL 或 runner 丢失不能保证资源已经回收。失败或取消且有合成证据目录时，上传场景摘要、关联事实、效果文件与清理报告，保留 7 天；目录中不包含完整数据库或凭据。

这些检查只使用本地合成 provider 和普通账号，不调用 `check:provider`，不发送公网 Push、不发布镜像／Release或部署，不更改宿主账号、权限或仓库保护。macOS 上同一命令通过只证明跨平台源码行为；实际 Linux 通过证据须记录远端 Actions run URL、实际 SHA 与终态，并在 PR 合并前核对。真实 provider、VPS 和宿主用户服务安装各自单独报告，未执行时保持“未验证”。

## 源码开发

控制面本地启动需要一个只有当前用户可读的初始密码文件（12–1024 UTF-8 字节）和一个绝对数据目录：

```sh
export MATE_CONTROL_PLANE_DATA_DIR=/ABSOLUTE/private/control-plane
export MATE_OWNER_PASSWORD_FILE=/ABSOLUTE/private/owner-password
pnpm start:control-plane
pnpm dev:web
```

浏览器打开 `http://127.0.0.1:5173`，Vite 将 `/api` 转给本机控制面。PWA 注册和授权入口可在安全的 localhost 上检查；真实公网 Push 送达、域名证书和 Caddy WSS 须在 HTTPS 部署上验证。Web Push 的仓库测试只注入本地伪发送器，验证通知选择、去重、失败不回滚和落点；它不向第三方服务发送通知。

源码开发可用 `pnpm start:control-plane` 与 `pnpm start:node` 在普通账号下直接启动，不需要 root、用户创建或 service manager。节点需要 `MATE_CONTROL_PLANE_URL`；`MATE_NODE_DATA_DIR` 默认为当前目录下的 `data/node`，Agent 工作区根目录默认为节点数据目录下的 `agents`，可用 `MATE_NODE_AGENT_WORKSPACE_ROOT` 覆盖。创建 Agent 也走同一条普通账号路径：节点在运行账号可写的工作区根目录下建立该 Agent 的目录、记忆入口 `MEMORY.md` 和原身份标记，不创建 Linux 账号、不切换 UID/GID。工作区根路径不可写或目标目录已被其他内容占用时，网页按同一请求显示可诊断的失败原因。

```sh
export MATE_CONTROL_PLANE_URL=http://127.0.0.1:8787
export MATE_NODE_DATA_DIR=/ABSOLUTE/private/node
pnpm start:node
```

单账号启动检查以现有普通账号启动控制面与节点，通过真实 WebSocket 配对、创建两名 Agent，分别重启节点和控制面并核对重新认证、在线状态与错误身份拒绝。控制面真实 Durable 循环请求本地脚本化 HTTP/SSE 模型服务，调用节点普通命令并在每 Agent 原生 SQLite 持久保存 transcript；命令实测 UID/GID 和工作目录。脚本核对两名 Agent 独立工作区与 session、`MEMORY.md`、目录权限 `700`，以及没有按 Agent 创建账号。macOS 与 Linux 均可运行，并记录 `kernel`、`hostEnvironment` 与 `linuxKernel`；macOS 结果仅是跨平台证据。工作区不可写的网页失败由 `agent-creation-process.test.ts` 单独覆盖：

```sh
pnpm build
pnpm test:linux-single-account-node
```

工作区与记忆入口接缝另有一个跨平台检查：它不创建 Linux 账号、不要求 root，在同一运行账号下建立两名 Agent 的工作区，核对目录权限、`MEMORY.md`、原身份标记与重试复用，并确认已有内容的目录会被报告而不是被接管：

```sh
pnpm build
pnpm test:single-account-agent-workspace
```

从网页创建 Agent 到首次私信产生模型运行并写入该 Agent 自己的会话记录，由 `apps/control-plane/tests/runs/agent-loop.test.ts` 用真实控制面内 Durable 循环、本地 HTTP/SSE provider、WebSocket、节点与持久库覆盖；它在 macOS 与 Linux 上都会运行。数据目录的格式拒绝与日常接续见[运行手册](OPERATIONS.md#数据与日常接续)。

新增真实进程场景可使用 `apps/control-plane/tests/support/environment/scenario-environment.ts` 的 `createScenarioEnvironment({ agents, provider, controlPlane, node })`。`agents` 声明合成 Agent 资料；`provider` 沿用现有 `agent-loop.ts` 的 HTTP/SSE handler 与 `respond`；可选的 `controlPlane` 和 `node` 配置指定操作、命令与心跳时限。环境返回前已完成 Owner 登录、真实节点配对、合成模型凭据和 Agent 工作区准备；`agents` 返回实际资料（含 session ID）、Owner 私信频道与工作区。用 `request(path, { method, body })` 驱动真实 Owner API，场景不需要拼启动源码。启动文件 `scenario-services.mjs` 使用本次构建的控制面和节点；子进程以现有账号运行，只有必要变量、合成 HOME/临时目录及程序搜索路径。

每套环境拥有自己的临时目录、模型端口、控制面端口和进程；`restartControl()` 与 `restartNode()` 沿用这些目录和原身份，控制面重启会重新登录并等待节点重新认证。重叠重启会明确报错，等待当前重启完成后可再次调用。始终在 `finally` 中 `await environment.close()`；关闭报告的 `failures` 单独记录，失败的资源保留登记，可再次关闭重试。额外的本场景资源创建后立刻用 `registerCleanup(name, release)` 登记；显示名称不作为内部资源身份。用 `beforeClose(name, collect)` 在服务和文件释放前收集证据，启动失败也需要证据时使用配置的 `beforeClose(facts, signal)`。证据与释放回调均收到 AbortSignal，每项默认有 5 秒上限（可用 `cleanupTimeoutMs` 配置）；回调应响应取消并允许重复释放。失败或超时会记入报告，环境继续尝试其它资源；未确认释放的资源仍保留登记。再次关闭先有界等待上次尚未结束的释放，不同时调用同一回调；上次完成后确认其成功，或在其失败后重试。`observeProcess(service, output)` 提供已登记的真实进程输出，用于事件观察；配置的 AbortSignal 和驱动 SIGINT/SIGTERM 都进入同一清理流程。启动错误 `ScenarioStartupError` 保留原始 `cause`、进程状态、`cleanup` 和全部 `cleanupReports`，其 `close()` 保留失败资源的重试入口。`processes`、`resources`、`cleanupReports` 可用于报告已创建资源与残留，不扫描宿主已有服务。

`tests/scenarios/environment/ordinary-services.test.ts` 的第一条工具场景是短的可运行使用示例，其余测试覆盖双环境并行隔离、原身份重启、重叠重启拒绝、半途失败、监听前取消、真实信号取消、单项释放失败或超时后重试、资源名称碰撞与环境变量边界。它打印实际平台；macOS 结果是跨平台证据，Linux 结果也不代表真实 provider 或 VPS 已验证：

```sh
pnpm build
pnpm --filter @mate/control-plane exec vitest run tests/scenarios/environment
```

按 Agent 编写模型脚本时，使用 `tests/support/agent/scripted-provider.ts` 的 `createScriptedProvider({ timeoutMs })`，把 `handle` 交给同一环境。`forAgent(preparedAgent, steps)` 接收普通的命名 TypeScript 函数；每个 Agent 内步骤名称唯一，供 `waitFor(agentId, stepName)` 等待本步骤的真实请求。脚本按准备好的 session 分路，同 provider/model 的 Agent 不需要不同 model ID。固定测试启动文件只在既有 `modelForRun` 测试依赖中读取 session ID 并改写本地 URL；摘要的独立请求/缓存 ID 不作为 Agent 身份。`controlPlane.modelContextWindow` 只供真实压缩探针缩小测试模型上下文。

```ts
const provider = createScriptedProvider();
const environment = await createScenarioEnvironment({
  agents: [{ name: "场景同事" }],
  provider: provider.handle,
});
environment.registerCleanup("scripted provider", () => provider.close());
try {
  const agent = environment.agents[0];
  if (!agent) throw new Error("Expected prepared Agent");
  provider.forAgent(agent, [
    function executeCommand(request: ScriptedRequest) {
      request.call("process.exec", {
        command: "printf 'command-ran' > result.txt; cat result.txt",
      });
    },
    function inspectRealResult(request: ScriptedRequest) {
      const result = request.result("process.exec", scriptedToolResultSchemas["process.exec"]);
      expect(result.receipt?.stdout).toBe("command-ran");
      request.text("完成。");
    },
  ]);
  await environment.request(`/api/owner/channels/${agent.channelId}/messages`, {
    method: "POST",
    body: { text: "执行普通命令。" },
  });
  const result = await provider.waitFor(agent.summary.id, "inspectRealResult");
  expect(await result.outcome).toEqual({ kind: "responded" });
  await provider.assertComplete();
} finally {
  await environment.close();
}
```

完整可运行版本在 `tests/scenarios/environment/ordinary-services.test.ts` 的普通命令场景，导入 `createScriptedProvider`、`ScriptedRequest` 和 `scriptedToolResultSchemas` 后即可使用。`request.text`、`call` 和 `tools` 复用既有 OpenAI Responses SSE；每个响应与工具调用有新的 ID。`request.result(name, schema)` 按实际调用 ID 找到对应结果并用 Zod 解析；常用对话、任务和命令结果投影在 `scripted-tool-results.ts`，其它真实结果可传已有领域 schema。它不制造工具结果或写业务库。

模型请求与步骤默认都在 5 秒内结束；等待命名步骤也有截止时间。暂留响应可让命名步骤直接返回，由驱动拿到请求后调用 `text` 或 `call` 释放。异步步骤应响应 `request.signal`；`assertComplete()` 等待有界步骤收尾，包含等待期间新增的步骤，再拒绝错误、未用步骤或待响应请求。意外请求、脚本耗尽、步骤失败、步骤超时和响应超时会记录含 Agent/session、步骤与实际请求的 `ScriptedProviderError`，没有隐式“完成”兜底。预期客户端取消需先调用 `request.expectCancellation(reason)`，实际 HTTP 关闭后 `outcome` 为 `cancelled`；未声明的取消为失败，框架关闭为 `closed`，待响应超时为 `timeout`。已结束请求再释放返回 `late`，脚本关闭后新请求报告 `late_request`，不会继续执行步骤。`close()` 返回 Promise，登记到环境现有清理入口并在直接调用时等待它。它立即关闭待响应请求，给已经就绪的 Promise 接续一次事件循环机会，按步骤函数的实际返回或 Promise 完成结清收尾，避免把正常回复后的立即关闭误报为中断。已响应但异步代码尚未结束的步骤被关闭时记录 `step_cancelled`，不能因此通过完成检查；随后出现的非取消异常仍记录原始 `cause`。异步代码响应取消时可抛出 `request.signal.reason`，仅该取消原因被视为正常收尾；合成请求与诊断保留在 `requests`/`errors`，可在环境的 `beforeClose` 中读取。

`tests/providers/scripted-agent-routing.test.ts` 与同目录的生命周期测试 用真实 CP/node/Pi/HTTP-SSE 验证同 model 双 Agent 交错、动态任务身份、重复命令调用的正确结果、真实摘要与普通请求分路，以及取消、迟到、耗尽和截止时间。它只用合成模型凭据，不代表真实 provider 或 Linux VPS 已验证：

```sh
pnpm build
pnpm --filter @mate/control-plane exec vitest run tests/providers/scripted- tests/scenarios/environment
```

场景驱动使用 `tests/support/scenario/scenario-driver.ts` 的 `createScenarioDriver(environment)`。`sendOwnerMessage(agent, text)` 只发送普通 Owner 消息，先记录该 Agent 当前活动游标，返回实际消息、Agent/session 身份和游标。将返回值交给 `waitForRun(target, "completed")`，等待该消息所属 run 的持久关联和游标后的 Owner 运行活动共同成立；已有 completed 不会满足新消息。已取得 run ID 时可传 `{ ...target, runId }`，将等待固定到那一轮。观察即将释放的同伴反馈时，先 `observe(agent)`，再用实际消息工具结果组成 `{ ...observation, message }`。这些关联只是观察条件，不限制 Agent 阅读或行动。

`messages(channelId)` 读取分页主时间线，`thread(channelId, rootId)` 读取根消息及回复，`tasks()`、`attachments(channelId)` 和 `activity(agentId, after)` 分别读取真实 Owner API，并复用协议 schemas；活动投影在读取边界核对现有 `AgentActivityEvent` 契约。`waitForTask` 要求具体 ID、消息锚点、频道、负责人和状态；`waitForMessage` 要求具体 ID、频道、rootId、作者和文字。`assertAttachment({ agent, channelId, attachmentId, path, expectedBytes })` 核对实际上传者、附件元数据以及三份字节：Owner 下载、真实 Agent 工作区文件和独立的合成预期。它们不调用 Agent 工具，也不写业务数据库。消息与 run 的关联仅在 `scenario-facts.ts` 中集中打开只读数据库：run 原始 seed（启动该轮的实际投递）在输入提交前也有明确关联；其它消息须在本轮入参上界内，且有该 seed 对应操作范围中由本轮或更早轮实际提交的投递 ID。恢复保留原范围和已确认上下文，但后续轮才提交的新输入不会回填到旧轮。提醒轮没有实际接收的普通消息不会因序号范围重叠而误归属。查询不以任意非空行表示成功，也不替代实际模型请求中的上下文断言。手动暂停只有 Agent 级活动，因此 failed 等待核对该轮持久失败状态和原启动活动；completed 还必须有该轮的 Owner 完成活动。

条件等待共用 `waitForScenario(label, read, matches, { timeoutMs, signal })`，默认 5 秒；截止时间覆盖读取本身和轮询间隔，取消信号也传给 Owner HTTP 请求。条件未成立、读取失败和取消都抛出带原始 `cause` 的 `ScenarioWaitError`，含等待标签和 `lastFacts`（最后一次完整观察；尚无观察时为 `undefined`）。`tests/scenarios/driver/report-task.test.ts` 的短单 Agent 报告是完整可运行样例：先完成 R1，再发新的 Owner 普通消息，由 R2 自己读取、创建/认领任务、用真实普通命令生成总计 12 的文件、发布附件、显式回复原请求并完成任务。反例覆盖旧消息/游标、错误 run ID、错误负责人/作者、真实事件流停滞与取消，以及 run 已结束但任务仍在进行中。提醒与普通消息同批场景核对各实际请求中的输入；seed 输入提交前的控制面 SIGKILL 场景复用既有 `loopFixture` 提交钩子，验证旧轮中断与同 session 的新轮恢复。后到消息，以及原已同批但尚未提交的消息，都验证后续恢复提交不会反向归属旧轮。新增场景只需描述模型步骤、输入和预期成果：

```sh
pnpm build
pnpm --filter @mate/control-plane exec vitest run tests/scenarios/driver
```

`message-tasks.test.ts` 沿用这些真实进程和持久库，验证消息及回复的多任务、两位 Agent 的明确认领与并发新增、消息草稿交错。任务提交后模型结果尚未确认时的控制面重启场景已迁移到下文的 `tests/scenarios/recovery/`。模型输出由本地脚本 provider 指定，只验收工具和恢复能力；它不代表真实模型服务连接或 VPS 部署已验证。中文网页的标题输入和全部关联任务展示由 `apps/web/tests/tasks/message-cards.test.ts` 的现有交互接缝覆盖。

```sh
pnpm build
pnpm --filter @mate/control-plane exec vitest run tests/tasks/message-tasks.test.ts
pnpm --filter @mate/web exec vitest run tests/conversations tests/tasks/message-cards.test.ts tests/contracts/conversation-responses.test.ts
```

普通命令执行在同一个现有普通账号下运行：Agent 的命令进入当前账号的 shell 子进程，默认使用该 Agent 的工作区，返回有界输出、退出码、截断与超时标记，命令里的 `sudo` 原样交给宿主。`agent-loop.test.ts`、`agent-loop-recovery.test.ts` 和 `tests/tools/recovery/invalidation.test.ts` 在真实控制面内 Durable 循环、WebSocket 和节点中核对命令/文件工具、控制面提交边界、节点重启收据复用与未知结果。`agent-loop-lifecycle.test.ts` 核对模型/摘要停滞时取消、凭据暂停、离线和同节点多 Agent 并发；`agent-loop-attention.test.ts` 核对忙时主动读取、暂缓、继续、下一轮同 session 与发言新鲜度选择：

```sh
pnpm build
pnpm --filter @mate/control-plane exec vitest run tests/runs/agent-loop.test.ts tests/runs/agent-loop-recovery.test.ts tests/tools/recovery/invalidation.test.ts
```

命令的失败与恢复语义另有一个只做真实进程工作的检查：它用真实 shell 子进程跑一条超时命令，模拟节点进程在命令运行中消失，再用同一份收据数据库把节点"重启"，确认同一操作 ID 重放记录而不是重跑命令：

```sh
pnpm build
pnpm test:linux-ordinary-command-failure
```

该检查以启动账号运行，不需要 root、容器或服务管理器，macOS 与 Linux 都可运行，并打印一行 JSON 证据；它记录 `kernel`、`linuxKernel` 与 `containerized`。它不覆盖宿主的 `sudo` 策略：普通账号无法终止 `sudo` 派生的 root 后代，Mate 对此不作任何声明。

`apps/node/tests/files/same-account-files.test.ts` 与 `apps/node/tests/provisioning/agent-workspace.test.ts` 覆盖文件工具在普通账号下的执行、工作区准备，以及节点以 root 运行时拒绝报告运行账号。`apps/control-plane/tests/agents/profile-model.test.ts` 覆盖控制面拒绝以 root 账号完成的 Agent 创建。**不要再引入以 root 运行节点、按 Agent 创建 Linux 账号或按命令创建 systemd 单元的检查**：这些旧路径已移除。ADR-0009 的 由统一 CLI 管理的 node 用户服务是有限包装范围，不是 Agent 执行路径。

# Agent token 与缓存统计

所有者登录后，可携带登录 Cookie 请求 `GET /api/owner/agents/{agentId}/usage`。接口汇总指定 Agent 的主会话与全部助手的 Durable 原生模型累计、已提交普通响应及 provider 可用性元数据。fork 继承的历史只计原 conversation 自己提交的响应一次；原生摘要可用性按 provider session 关联。Agent 不存在返回 404，未登录返回 401。响应设置 `Cache-Control: no-store`，不提供网页面板。

普通响应及摘要的观察元数据与原生统计在同一提交内保存。摘要仅保留字段可用性、请求计数和加权缓存分母的聚合；其数值从原生 `pi.usage.models` 按 provider/model 扣除同一稳定提交范围内的全部普通响应，不使用历史工具过滤后的成功集合，也不包含 `pi.usage.tools`。不保留第二份请求或 transcript 账本。

响应中的 `total`、`normal`、`summary` 分别是全部请求、普通请求和会话压缩摘要请求的累计；`latestNormal` 是最后一次普通请求的记录 ID、原生响应时间 `recordedAt`（Unix 毫秒）和该次统计。没有普通请求时 `latestNormal` 为 `null`。失败响应只要返回并被确认，其实际报告的用量也计入；失败摘要不因此成为有效压缩。

每组的 `requestCount` 包含已确认的模型响应，以及 Durable 已计入累计的中断普通响应。中断时仅保存原生流式进度而丢失 provider 报告可用性时，该次请求的字段保持未知。`tokens` 分别列出 `uncachedInput`（未缓存输入）、`cacheRead`（缓存读取）、`cacheWrite`（缓存写入）、`allInput`（前三者之和）、`output`、`total`（全部输入加输出）和 `reasoningOutput`（若报告，是输出的子集，不再加到总数）。每个指标包含 `value`、`knownRequests` 和 `missingRequests`：只汇总供应商字段足以确定的请求；没有可确定的值时 `value` 为 `null`，真实零则为 `0`。供应商只报告包含缓存的输入时，不再次把缓存读取量加上去。

`cacheHitRate.value` 是具备完整缓存读取量及全部输入量、且全部输入大于零的同一组请求中，缓存读取 token 总数除以全部输入 token 总数。它是 token 加权的比例，缓存写入进入分母而不算命中，输出不进入分母。`knownRequests` 与 `missingRequests` 显示该比例覆盖了多少请求；缺字段或分母为零的请求不进入比例。没有请求、字段缺失或分母为零时比例为 `null`。这些数字只覆盖控制面收到并确认的响应，不估计供应商侧未送达的计费记录，也不构成用量或运行额度。

Pi 当前的 Google SDK 适配器不开放响应体截取，并把未报告的字段归一成零。Mate 对这一路径只将 Pi 返回的正值视为已报告；归一化零仍显示为未知，不能据此声称 Google 的缓存命中率为 0%。

## 提示词构建与本地诊断

提示词统一入口为 `apps/control-plane/src/prompts/index.ts`。`system.ts` 构建 Mate 的中文 Agent 指引，`runtime.ts` 构建输入来源、忙时通知和收据更正；Durable 原生负责系统提示的顺序变化、容量判断、摘要请求、压缩提交与重启接续。摘要不启用后台预压缩。

先构建，再查看实际安装的控制面、Durable、Pi AI、Chord 版本及当前指引的来源、顺序和启用条件。默认不输出正文，不读运行目录、数据库或环境凭据：

```sh
pnpm build:control-plane
pnpm prompt:inspect
pnpm prompt:inspect --show-content
```

`--show-content` 显示合成 profile 的系统提示。需要核对历史系统变化时，把 Durable 公共存储接口读取的一条 `pi.system` entry 保存在自己控制的私密 JSON 文件，再显式指定：

```sh
pnpm prompt:inspect --entry /ABSOLUTE/private/system-entry.json
pnpm prompt:inspect --entry /ABSOLUTE/private/system-entry.json --show-content
```

要核对某个 Agent 实际采用的原生模型、系统提示和工具定义，可明确指定其会话文件；读取不会打开 Harness 或推进工作：

```sh
pnpm prompt:inspect --session /ABSOLUTE/data/control-plane/durable/AGENT_ID.sqlite
pnpm prompt:inspect --session /ABSOLUTE/data/control-plane/durable/AGENT_ID.sqlite --show-content
pnpm prompt:inspect --session /ABSOLUTE/data/control-plane/durable/AGENT_ID.sqlite --conversation 2
```

会话诊断默认读取唯一主会话（ID 1），`--conversation ID` 明确选择同一库中的助手会话；输出 `conversationId`，未知 ID 拒绝。现有 Agent 动态的节点操作给出 `sourceConversationId`，网页同时标记主会话或工作助手。诊断区分该会话最近普通响应的 `model` 和当前存储的 `configuredModel`；`runtimeVersions` 是最近整组准入保存的版本，`inspectorVersions` 是当前诊断命令的版本。系统提示和工具由已提交的原生系统变化重放，压缩前后均使用固定记录范围；默认只显示长度和数量，展开才输出原文与定义。

`configuredThinkingLevel` 显示该会话已采用的选择（默认或低/中/高），`requestThinkingLevel` 是最近保存普通响应对应请求的原生级别；默认对应 off，无可观察响应时为 `null`。它表示发送给 Pi 适配器的请求配置，不推断 provider 实际思考投入或跨模型等效力度。摘要继续使用 Durable 的原生策略，不另设摘要强度。

单条 `pi.system` 记录是系统片段和工具定义的顺序增量，不是完整配置快照；默认只报告数量，显式显示内容时才输出片段与工具变化。诊断不输出无关字段，失败不回显文件名或输入内容。原文可能包含私密 profile，文件和输出都不应提交到 Git。旧 configuration 快照读取与旧摘要字节快照已删除；前缀、压缩和恢复行为由真实本地模型请求场景验证。

## 所有者主动检查真实模型供应商

`pnpm check:provider` 是独立的主动检查入口。它不会由 `pnpm check`、PR/main CI 或定时任务调用。先运行 `pnpm build`，再用 `pnpm check:provider --list` 选择 Mate 已支持的 provider/model。所有者自行准备只有自己可读的 API key 文件（例如权限 `600`），显式指定后才会请求供应商；不会读取 Mate 数据库或环境变量中的 API key。未指定文件、文件为空或不可读时记为 `unverified`（未验证），不阻塞其它开发。

```sh
pnpm check:provider --provider openai --model gpt-4o-mini
# 上一条缺少凭据，只报告未验证。下一条会实际调用所选供应商。
pnpm check:provider --provider openai --model gpt-4o-mini --api-key-file /ABSOLUTE/private/provider-key
```

检查复用真正的 Pi Agent/core 和 Pi 供应商适配器，在内存中观察一条短文本流结束，再调用一次 `mate_protocol_probe`。这个工具仅返回临时随机标记，不读写文件、不执行 node 命令、也不访问外部服务。第三次请求携带对应的非空调用 ID、工具声明和工具结果；只有续接正常结束、实际回复该标记且未再次请求工具，才报告 `passed`。工具未调用、结果未被确认或续接再次请求工具分别报告 `tool_not_observed` / `tool_result_not_acknowledged` / `additional_tool_call` 和 `unverified`。经完整协议终止证据确认的结构化模型拒绝（例如 Anthropic 的 `refusal`、OpenAI 的 `content_filter` 和 Google 的 `SAFETY`）报告 `model_declined` / `unverified`；拒绝原因后发生截流或解析错误仍是协议失败。Google SDK 不提供 fetch 钩子，检查依照固定 Pi 版本中仅在 SDK 流正常结束后生成的完成诊断区分拒绝与 SDK/解析错误。这些模型选择不算 harness 失败，也不要求模型完成协作或故障矩阵。

真实传输或协议错误报告 `failed` / `provider_error`、发生阶段和实际捕获的 HTTP 状态（不可观察时为 `null`）；空或不匹配的工具调用 ID 报告 `failed` / `tool_call_not_associated`，不发送无法关联的续接。失败进程退出码为 1。Ctrl+C / SIGTERM 报告 `owner_cancelled`；`--timeout-ms` 设置本次检查的等待期限（默认 30 秒，最多 5 分钟），超时报告 `timeout`；二者均为未验证。这是主动检查的等待期限，不影响 Mate Agent 的 token、费用或 run 使用量。

JSON 仅含所选模型、状态、阶段、HTTP 状态及协议观察布尔值，不保存或上传完整提示/回复、凭据、文件路径、原始错误正文或随机标记。入口不创建 Mate Agent、持久会话或外部服务资源。结果只描述本次实际观察到的错误或取消；成功检查不会声称也测试了其它错误类型。

`tests/providers/check-*.test.ts` 用本地合成 HTTP/SSE 服务验证真实 Pi 的文本、工具关联/续接、模型未调用、Anthropic/Google 拒绝与不完整协议的区别、空调用 ID、重复工具、HTTP 拒绝、截流与取消，以及 CLI 缺凭据行为。注入合成服务的结果始终标记 `connection: "synthetic"`；所有者入口标记 `connection: "real"`，仍须同时有 `status: "passed"` 才能算本次真实连接验证通过。合成验证不会自动触发真实调用。当前真实 provider 结果应单独报告，未配置/未调用时写“未验证”。

## 场景失败证据与独立回收

新增场景可用 `tests/support/scenario/scenario-evidence.ts` 的 `runScenario({ name, provider, environment, run })` 包住整套工作。`provider` 是 `createScriptedProvider()` 的返回值，`environment` 直接沿用环境配置；`run` 收到已就绪的 `environment`、同一个 `driver`、取消 `signal`、`step(name, action)` 和 `effectFile(name, workspacePath)`。`step` 执行普通函数、保留实际返回事实并记录通过／失败；`effectFile` 只登记本场景 Agent 工作区中的具体合成成果，不复制目录、数据库或用户文件。`scenarios/evidence/assertions-cleanup.test.ts` 的第一条短报告场景是可运行例子；完整 workflow 可直接沿用此入口。

包装使用环境现有 `beforeClose` 保存有序模型请求与工具结果、只读会话／run／operation 投影、node 本地命令及文件收据、本场景所有频道与完整讨论串、Owner 任务／活动／附件元数据、显式效果文件和进程输出。在任何 API 等待前先写基础摘要，采集期限届满也保留原错误、命名步骤和最后事件；后续补充取得的事实和保存错误。摘要记录实际 `git rev-parse HEAD`、是否有未提交修改、内核／平台／架构、命名断言和最后成功事件；不会把规划基线当成被测版本。证据排除已用密码、Cookie、配对／模型凭据，以及凭据字段、Bearer 值和私钥文本；场景只允许合成数据，不应向它注入真实用户目录或凭据。

成功后删除本次证据目录；失败打印 `MATE_SCENARIO_EVIDENCE <本地目录>` 并抛出 `ScenarioFailure`。原始错误在 `cause`，保存错误在 `evidenceErrors`，资源释放结果在 `cleanup`；`close()` 直接重试原环境尚未确认释放的登记项。清理结果另存 `cleanup.json`，不会覆盖清理前的摘要。默认目录为当前 checkout 根下的 `artifacts/scenarios/scenario-*`（可用 `evidenceRoot` 指定）；CI 可以直接上传该目录。框架自身的受控失败由外层测试核对，正常 `pnpm check` 仍必须全绿。

SIGINT／SIGTERM 通过同一取消和登记清理路径收尾。SIGKILL 不能执行 `finally`；创建环境时立即写入证据目录的 `resources.json`，服务启动后更新其 PID、随机归属标记与参数。独立回收记录有限的进程状态、身份匹配结果及实际信号，不复制未知进程的参数；`Z` 表示进程已经退出但 PID 尚待父进程回收，无需发送信号。存活且身份不符的进程仍报告残留，不发送信号。在驱动确实退出后可独立运行：

```sh
pnpm cleanup:scenarios -- --root artifacts/scenarios
# 也可只回收一套场景：
pnpm cleanup:scenarios -- /ABSOLUTE/evidence/scenario-XXXXXX/resources.json
```

独立入口只读取指定目录的本次 manifests，核对私有运行目录中的归属标记及各服务进程的实际参数，尽力停止已确认的 CP/node，再删除本次运行数据。即使运行目录已不存在，也继续核查清单中的服务，避免把删除目录当成停止服务。驱动还在、身份变化、标记错误或不能确认退出时报告 `residual`／`errors` 并非零退出；不会扫描用户服务或全局 prune。它不能重新执行驱动进程中的自定义释放闭包，也不声称任意命令后代都已回收。常规关闭仍由环境唯一的登记／释放机制负责。

```sh
pnpm build
pnpm --filter @mate/control-plane exec vitest run tests/scenarios/evidence
```

该文件覆盖短真实命令场景的断言失败、无法达到事件的超时、真实 SIGINT／SIGTERM、保存与单项释放同时失败、采集 API 停滞、半途启动失败、合成凭据排除，完整公共讨论串和 node 收据，以及杀死实际驱动后（包括运行目录已缺失）独立回收和再次运行。退出竞态回归用 `cc` 编译一个小型临时 holder，通过 `waitid(WNOWAIT)` 保留真实已退出 Node 的 PID，再验证回收器读取 `Z` 状态且不发送信号；另一个真实 Node 连接重试场景验证准备期间终止 holder 也终止并回收其直接子进程。测试失败保留首错、初始报告和路径，收尾错误单独报告；通过后删除本次临时文件。它只用本地脚本模型；macOS 结果是跨平台证据，不替代 Linux CI、真实 provider 或 VPS 验证。

## 新增正常工作场景

在 `apps/control-plane/tests/scenarios/` 新建普通 Vitest 测试，复用 `runScenario`；只写本场景的 Agent 配置、命名模型步骤、Owner 输入和成果断言。短单 Agent 样例可从 `scenarios/evidence/assertions-cleanup.test.ts` 的第一条真实报告测试开始，其核心用法如下（导入路径相对于这个测试目录）：

```ts
import assert from "node:assert/strict";
import { join } from "node:path";
import { it } from "vitest";
import { runScenario } from "../support/scenario/scenario-evidence.js";
import { createScriptedProvider } from "../support/agent/scripted-provider.js";
import { scriptedToolResultSchemas } from "../support/agent/scripted-tool-results.js";

it("writes a short report with a real command", async () => {
  const provider = createScriptedProvider();
  await runScenario({
    name: "short-report",
    provider,
    environment: { agents: [{ name: "报告同事" }] },
    async run({ environment, driver, signal, step, effectFile }) {
      const agent = environment.agents[0];
      assert.ok(agent);
      provider.forAgent(agent, [
        function writeReport(request) {
          request.call("process.exec", {
            command: "printf 'total=12\\n' > report.txt; cat report.txt",
          });
        },
        function acknowledgeReport(request) {
          const result = request.result("process.exec", scriptedToolResultSchemas["process.exec"]);
          assert.equal(result.receipt?.stdout, "total=12\n");
          request.text("本轮内部正文结束。");
        },
      ]);
      effectFile("report.txt", join(agent.workspace, "report.txt"));
      await step("report run completed", async () => {
        const work = await driver.sendOwnerMessage(agent, "写合成报告。");
        return driver.waitForRun(work, "completed", { signal });
      });
      await provider.assertComplete();
    },
  });
}, 30_000);
```

完整双 Agent 样例的模型步骤与成果断言在 `tests/scenarios/report-workflow.ts`，测试入口在 `tests/scenarios/report-workflow.test.ts`。入口仍只有 `runScenario({ name, provider, environment, run })`，`environment.agents` 使用导出的 `reportWorkflowAgents`，`run` 调用 `runReportWorkflow(context, provider)`。因此其它交付拓扑可以复用同一函数及现有 `ScenarioContext`，无需复制启动、SSE、等待或证据逻辑；本样例不增加通用适配平台。

Owner 发送普通请求后，甲实际创建并认领主任务，写入 2、4、6，用普通命令生成含总计 12 的草稿，再发现乙、建立 peer DM、发布草稿附件并发送带 `asTask` 的独立复核请求。脚本只暂留乙的真实 HTTP 响应；驱动确认甲 R1 已结束且主任务仍在进行后释放。乙读取附件原字节，通过工作区工具保存到自己的文件，再用命令实际读取并校验；乙在原复核讨论串反馈记录数 3，完成自己的任务。

实际反馈触发甲 R2；模型请求保留 R1 的有序前缀，甲读取复核讨论串后修订文件，在 Owner 原请求讨论串显式交付，并完成主任务。断言核对 Owner 下载、甲最终文件与预期字节相等，乙校验文件与已发布草稿字节相等，两个任务各自的锚点／负责人／状态，以及甲跨两个 DM、讨论串和两次 run 的同一 session、乙的独立 session、每 Agent 至多一个 current run。任务设为 done 时 run 仍在进行，普通模型正文仍只在会话中；结束 run 后再核对成果。复核只是本样例的自主协作选择，不是产品强制流程或父子任务。

```sh
pnpm build
pnpm --filter @mate/control-plane exec vitest run tests/scenarios/report-workflow.test.ts
```

这条测试也由 `pnpm check` 收录。失败沿同一个证据与清理入口报告实际步骤和关联事实；只使用合成模型和文件，实际平台以执行结果为准，真实 provider、Linux CI、容器和 VPS 各自验证。

## 真实命令的 node 崩溃与收据边界

每条场景在模型工作前准备空的合成效果计数文件，并立刻登记其真实路径，零次、一次及禁止的重复效果都能在失败清理前保存。受控失败回归让真实命令写入两次效果，确认原断言失败时证据仍保留两条原始记录；它不会把失败效果改写成通过结果。

`tests/files/command-crash-recovery.test.ts` 复用同一 `runScenario`、按 Agent provider 和消息/run 驱动，补充两个精确进程边界：`node.commandBoundary: "before_execute"` 在 node 持久保存 start 后、真实执行器调用前暂停；`"before_receipt"` 在真实命令返回后、ledger 提交收据前暂停。固定测试启动文件通过既有 node 测试依赖包裹真实 ledger/executor，不提供生产故障配置。事件输出携带实际 Agent、operation ID 和原请求。暂停默认最多 15 秒，响应 node 终止取消；在本场景的 `node-data/command-boundary-release` 写入合成释放文件可继续，本票也验证释放后同一 run 完成且效果一次。已到达的标记只在当前私有数据目录保存，原身份重启不会再暂停新的检查命令。

两条崩溃场景先核对 durable start、空收据和实际效果（分别零次／一次），再发送 SIGKILL 并核对目标 node 的真实退出信号。重启复用原身份、数据和唯一 session，原 operation 对账为 unknown；实际恢复模型请求先看到关联原 operation 和请求内容的未知事实，再主动执行新命令检查原效果。检查也可正常产生新的记录；历史未知保持未知，不能自动判成功／未执行或自动重放。持续心跳可能在崩溃前已把尚无收据的操作记为未知，这与命令效果是分别观察的事实。场景完成后核对效果计数、原操作身份和 revision、旧 run 失败、新 run 完成及有序上下文前缀。失败沿公共证据入口保留步骤、真实进程状态、操作收据和已登记效果文件。

已存在的命令路径继续复用：`tests/tools/recovery/invalidation.test.ts` 的 `disconnect/restart at receipt ... command` 在真实收据落盘后截住回包，检查控制面未收到时的原意图，并在断链或 node SIGKILL 重启后按 operation ID、Agent、原请求摘要和节点收据核对。这里补充实际恢复模型在新工具前收到原 succeeded 结果、对账的新 requestId 与回包 requestId 匹配且不同于执行往返的断言。`disconnect at unconfirmed ... command` 仍覆盖已有命令效果后的崩溃；`pnpm test:linux-ordinary-command-failure` 保留普通账号 timeout、命令仍运行时 node 退出和原收据不重放检查。该脚本的 node 是主动硬退出，不能冒充 SIGKILL 证据。SIGKILL node 也不等于所有 shell 后代已结束；本场景只报告实际目标退出和效果，不扫描宿主进程、不使用 sudo、切换账号或修改权限。其它失效与文件矩阵保留，不为了统一而重写。

```sh
pnpm build
pnpm --filter @mate/control-plane exec vitest run tests/files/command-crash-recovery.test.ts
pnpm --filter @mate/control-plane exec vitest run tests/tools/recovery/invalidation.test.ts -t 'disconnect at receipt stops the old command|restart at receipt stops the old command|disconnect at unconfirmed stops the old command'
pnpm test:linux-ordinary-command-failure
```

Vitest 场景均由 `pnpm check` 收录；独立普通命令脚本仍按上述入口运行。命令输出的实际平台决定证据归属，macOS 是跨平台验证，不替代 Linux CI、真实 provider 或 VPS。

## 在真实模型事件点控制节点链路

`node: { networkProxy: true }` 让本场景的主 node 通过 `scenario-network.ts` 的原始 TCP 代理连接 CP；Owner API 和 `additionalNode()` 新建的独立节点仍直连同一个 CP。代理不建立 WebSocket 端点，不回复 ping/pong，也不改宿主防火墙。`environment.nodeLink.observe()` 返回当前事件游标；`disconnect()` 立即关闭已建链路，`blackhole()` 保持现有 socket 并静默丢弃双向流量，两种模式都阻止后续连接绕过代理。`restore()` 明确恢复，并关闭残存连接，让真实 node 使用原身份重新认证。

在命名模型请求或实际摘要请求到达后注入，用 `nodeLink.waitFor(predicate, { after, signal, timeoutMs })` 等待游标之后的具体帧、关闭或被阻止的重连。它沿用驱动的期限、取消和最后事实报告；控制方法同步返回，关闭沿环境唯一的资源登记流程释放 socket 和监听端口。事件只保存连接号、方向、帧类型、丢弃事实及实际 Agent/run/operation/request ID，不复制含配对凭据的帧正文。失败证据另含 `network.json` 和 `network-queues.json`，与真实进程的退出／存活状态分开。

`tests/scenarios/node-network-recovery.ts` 导出 `nodeNetworkConfiguration` 和 `runNodeNetworkRecovery(context, provider, "blackhole" | "disconnect")`；原生入口与后续拓扑可复用同一模型脚本、驱动和断言。黑洞样例在 Pi 请求暂留期间发起真实 Owner 工作区只读预览，从而观察实际控制面到 node 的帧被丢弃；节点自身的心跳与关闭帧提供反向证据。随后等待 Owner 节点离线、指定旧 run 的 interrupted 活动与 HTTP 取消，尝试迟到任务／消息／附件／命令输出并核对无新增效果，再等待被阻止的真实重连后明确恢复。

迟到输出使用 `await request.releaseLate(content)`：仅在真实 HTTP 客户端关闭且 outcome 为 cancelled 后，仍调用既有 SSE 编码与原响应的写入。它记录每段写入是否被接受、实际响应销毁／结束状态和流错误，有请求配置的截止时间；取消终态保持不变。已关闭传输上的写入尝试不能送达 Mate，记录不会声称已送达或变成新响应。证据中的模型请求包含 `lateReleases`；恢复完成后再次核对旧 run 仍 failed、迟到内容未进入实际模型上下文／摘要，任务、消息、附件与操作没有新增。普通 `text`／`call` 的迟到调用仍只返回 late，不隐式触发这项故障尝试。

`tests/nodes/node-network.test.ts` 还覆盖实际待响应摘要取消、已确认 checkpoint 保留、离线普通消息与到期提醒、人工暂停不解除，以及独立在线节点在故障期间执行真实命令。普通请求恢复核对已确认上下文的有序前缀，摘要恢复核对实际模型收到确认摘要；恢复仍只有原 Agent session，旧 run 不重新取得资格。它们由 `pnpm check` 自动收录，单独运行方式如下：

```sh
pnpm build
pnpm --filter @mate/control-plane exec vitest run tests/nodes/node-network.test.ts
```

场景只使用合成数据与本地 HTTP/SSE。输出记录实际平台；macOS 通过不代表 Linux CI、容器、真实 provider 或 VPS 已验证。

## 控制面提交与重启恢复场景

`tests/scenarios/recovery/` 使用 `runScenario` 组织 CP 提交、压缩、任务结果、部分 SSE 和正常关停用例。每条场景使用下面的 ID；证据目录保存模型步骤、实际平台/SHA、进程输出与退出、原消息/run/session/operation、API 与效果文件。`tests/runs/agent-loop-recovery.test.ts` 覆盖工作区身份与拒绝提交，`tests/tasks/message-tasks.test.ts` 覆盖其它任务行为。

| 场景 ID                                             | 确定的事件和主要证据                                                                                                                                                                 | `tests/scenarios/` 下的实现                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `cp-assistant-before` / `cp-assistant-after`        | 完整 assistant 提交前/后暂停，SIGKILL 的真实退出，恢复请求的已确认有序前缀与一次命令效果                                                                                             | `recovery/committed-history.test.ts`，复用 `cp-restart.ts` |
| `cp-result-before` / `cp-result-after`              | 命令效果及收据已有、toolResult 未提交/已提交；恢复仅复用原 operation，旧 run 中断                                                                                                    | `recovery/committed-history.test.ts`，复用 `cp-restart.ts` |
| `cp-task-result-before`                             | 创建任务的事务已提交、toolResult 未确认；实际模型收到原收据，ID/锚点/创建活动保留，显式认领及随后新建任务仍可用                                                                      | `recovery/committed-history.test.ts`                       |
| `cp-compacted-pending-tool` / `cp-compacted-finish` | 已确认摘要和保留历史存在，待工具调用/完整结束之后 SIGKILL；恢复及后续实际请求保留同一摘要与保留前缀，不重附被摘要覆盖的 seed                                                         | `recovery/compacted-context.test.ts`                       |
| `cp-partial-sse`                                    | Pi 实际收到工具参数 delta 后 SIGKILL；取消及恢复完成后，半条消息没有入库/进入上下文，没有派发工具                                                                                    | `recovery/committed-history.test.ts`                       |
| `cp-sigterm-command`                                | 文件证明真实命令已经产生效果；CP 收到 SIGTERM 并正常退出、node 与命令 PID 仍存活，测试明确放行命令后晚到收据按原 operation 对账；真实对话工具读取更正消息，后续 run 按该消息关联等待 | `recovery/command-pause.test.ts`                           |
| `cp-manual-pause`                                   | Owner API 暂停实际待响应模型；重启和重新认证后 pausedReason 仍为 manual 且无 current run，显式恢复后沿原 session 完成                                                                | `recovery/command-pause.test.ts`                           |

```sh
pnpm build
pnpm --filter @mate/control-plane exec vitest run tests/scenarios/recovery/committed-history.test.ts
```

新增 CP 场景仍声明普通结构化配置。`controlPlane.commitBoundary` 使用 `{ phase: "before" | "after", role: "assistant" | "toolResult", toolName? }` 或 `{ phase: "finish" }`；固定测试启动器通过现有提交依赖暂停一次，15 秒未打断则失败。一次性标记位于本场景临时目录，重启不再次暂停，重启启动器不重新注入提交故障。`restartControl("SIGKILL")` 明确崩溃；默认 `restartControl("SIGTERM")` 走正常关停，两者记录实际退出状态。`controlPlane.observePartialTool` 仅通过已有测试依赖容器中的观测回调报告真实 Pi 工具参数 delta，不新增生产配置或故障 API。脚本的 `partialTool(argumentsPrefix)` 发送未完成 SSE 并保持待响应，需先声明预期取消。

`tests/scenarios/cp-restart.ts` 导出选定的 `runCpRestart(context, provider)`，默认复用 assistant 已提交但尚未派发命令的边界，供容器拓扑沿用同一模型脚本、成果与原身份断言。`scenario-recovery-facts.ts` 集中只读查询 Owner API 没有暴露的原 run、操作与工具收据；`durable-session-facts.ts` 通过只读 WAL 快照和公共 storage API 读取原生 entry，不启动 Harness。任务、活动、模型请求和文件仍为主要成果证据。这些场景加入 `pnpm check`；本地 macOS 结果不能代替实际 Linux CI、镜像、真实 provider 或 VPS 验证。

## 真实文件崩溃与收据边界

`tests/files/recovery/crash-boundaries.test.ts` 使用同一个 `runScenario`、Owner 驱动、真实 Pi 与 HTTP/SSE 脚本服务。`environment.node.fileBoundary` 只供固定测试启动器选择第一次文件变更的暂停点：`before_execute` 在真实执行器写好 `executing` 收据后、调用文件 backend 前；`before_receipt` 使用现有 `beforeReceipt` 钩子，在实际文件变更后、终态收据前；`after_receipt` 在真实执行器返回后、node 回包前。到达事件带实际 Agent／operation／请求内容及摘要，等待有期限和取消信号；原数据重启后标记不再暂停新操作。生产入口没有这些配置。

三条场景精确等待事件，再用 SIGKILL 终止本场景 node，并核对实际退出。执行前的原字节与版本保持不变；效果后的字节、inode 和纳秒版本证明原文件已变更，重启与对账没有再次替换。后续真实模型请求必须先看到旧文件结果未知，或看到原收据成功更正，再正常读取、补救同一文件或继续同一工作。控制面的唯一 session、各轮不重叠、原 operation 的真实派发与 backend 调用次数共同核验恢复没有盲目重放。收据后的场景先等实际工具超时产生未知结果、暂留模型响应，再崩溃／重启核对成功更正；这与未执行、已执行但无终态证据分别报告。

保留 `tests/tools/recovery/invalidation.test.ts` 的既有文件断链、收据前崩溃和收据后重启案例，并增强收据后立即断链／重启的 wire 断言：原 operation、Agent 与请求摘要保持，对账使用新的 requestId，各回包匹配所属往返，成功更正实际到达模型。文件事实通过 `scenario-facts.ts` 的只读动作／收据投影及 `scenario-file-facts.ts` 校验，不写业务库。失败继续使用现有证据与清理入口；测试只操作合成工作区，不运行命令代替文件变更。

```sh
pnpm build
pnpm --filter @mate/control-plane exec vitest run tests/files/recovery tests/tools/recovery/invalidation.test.ts
```

两条文件均由 `pnpm check` 收录。macOS 是跨平台本地证据，Linux CI、真实 provider 和 VPS 仍各自验证；这里的合成效果证明测试矩阵内的执行次数，不承诺任意远端副作用严格一次。

并发回归仍走真实双 Agent 文件路径：测试配置 `node.holdFirstFileExecution` 暂留首个操作的 backend，以带原操作身份的事件确认其已持久开始但尚未执行；另一 Agent 先真实完成文件与终态收据，此时不得出现首个操作的收据前事件。释放首个执行后，才观察它的真实效果与对应暂停点。启动器用 Node 的异步请求作用域关联既有 `beforeReceipt` 回调，避免另一 Agent 的完成错误标记目标操作；两道释放均有期限和取消信号。恢复历史还核对原 run 已持久提交的工具调用 ID／参数，收据后场景以崩溃前最后一个实际请求（含原调用和未知结果）核对完整恢复前缀。

## 交付镜像上的同一报告 workflow 与恢复场景

`pnpm test:container-scenarios` 从当前 checkout 使用 `deploy/control-plane/build.mjs` 和原 `Dockerfile` 构建唯一命名的本地镜像，随后运行 `tests/container/delivered-scenarios.integration.ts`。需要现有普通账号可操作的 Docker Engine/Compose、非零 UID/GID 和空闲的宿主 loopback 8787；缺少 Docker、交付文件、镜像构建或端口条件会明确失败，不跳过。构建不会下载 Mate Release、推送 registry 或部署。

每个场景先运行未改入口的生产 Compose，实际检查中文网页、登录、node 配对、容器内非 loopback 接口 HTTP、宿主 `127.0.0.1:8787` 发布、同账号 UID/GID 与挂载。随后在同一镜像、数据库目录和已配对 node 上切换隔离测试 override：只读挂载已有 `scenario-services.mjs`，通过既有测试依赖注入脚本模型／提交暂停点。生产 Compose 和镜像没有测试 hook。合成 provider 在宿主临时端口监听供容器通过 `host.docker.internal` 回调；Linux 使用 Compose `host-gateway`，node 仍连接宿主 loopback，网络代理仅控制指定 node 链路。

套件直接复用 `runReportWorkflow`、`runNodeNetworkRecovery(..., "blackhole")` 和 `runCpRestart`：相同模型步骤、真实任务／附件／工作区文件、唯一 session 与原 run 断言在交付拓扑执行；只选 assistant 提交后 SIGKILL，不复制深层提交矩阵。Owner 下载仍与真正发布的附件字节及 node 成果文件比较，CP 没有 node 数据／工作区挂载。node 使用本次源码构建和宿主 Node，结果不声称使用完整发布包。

容器套件固定使用显示成功日志的 reporter。`MATE_CONTAINER_PRODUCTION` 与 `MATE_CONTAINER_WRAPPER` 分别记录原入口和包装器的被测 SHA、镜像 ID／架构、宿主与容器实际环境、UID/GID、端口和挂载；失败沿 `artifacts/scenarios` 保存同一摘要、实际模型请求、关联事实、效果文件与清理结果。新增 SIGKILL 驱动探针证明活驱动拒绝独立删除，驱动退出后只按清单和 Docker 归属标签回收本项目的容器／网络及 node；重复回收确认资源已不存在。每个 Compose project 在创建前登记，覆盖创建中断；不会扫描或 prune 宿主其它 Docker 资源。

`pnpm check:ci` 在既有检查和三个普通账号脚本之后运行此入口；既有 CI `always()` 清理继续读取同一资源清单，失败证据仍由同一步上传。成功场景释放容器、网络和合成目录，驱动最后删除自己的唯一镜像标签。SIGKILL／runner 丢失仍只能由独立清理尽力回收，不能保证 finally 执行。

本地 macOS + Linux arm64 Docker 的通过只证明该混合拓扑；真正 Linux host 的证据须来自新提交的实际 CI。容器通过不代表 systemd 用户服务、linger、bootstrap／CLI 安装／整包更新／卸载、Ubuntu／Debian × x86_64／arm64 宿主矩阵、真实 provider、公开 HTTPS/Web Push 或 VPS 部署。

## 工作助手与设置验证

`tests/runs/working-subagents.test.ts` 和 `assistant-communication.test.ts` 通过 Owner API、真实 Durable、本地 HTTP/SSE 与真实 node 验证并行/递归工作、父空闲、通信、暂停、断连、重启和收据更正。`assistant-failure.test.ts` 另以原生 MemoryStorage 与模型流 stub 检查无正文 fault 等必要的适配契约，不是 HTTP/node 集成证据。`assistant-observation.test.ts` 核对全会话用量、并发摘要中断、历史与动态来源；`assistant-settings.test.ts` 用实际请求核对低/高/默认、模型/凭据更新、原输入与 provider session 保留，以及旧 prepared 请求在配置更新后崩溃恢复。网页 `tests/agents/agent-editor.test.ts` 验证能力选项、保存/刷新和不兼容模型切换。交付容器场景另验证工作助手留在原控制面挂载目录、SIGKILL 后原上下文与单次节点效果恢复。所有模型响应仍为合成脚本，不代表真实 provider 或 VPS。

## Agent 已确认历史检索

Agent 通过 `tools.list` / `tools.describe` 发现 `history.search` 与 `history.read`，再由 `tools.call` 调用。两个工具沿用当前 run、node、Agent 核验，不接受目标 Agent 或目标原生 conversation；只观察调用者当前 conversation 的已确认原生历史（包括 fork 继承的已确认记录），助手不会查到未继承的主会话或同级助手历史。不改变注意力、任务、权限、压缩点或操作收据。配置、用量、失败响应、流式未确认片段和未消费的 pending correction 不在结果中。压缩只改变后续上下文，原记录 ID、时间和正文继续可读；旧历史不是当前指令或重新执行工具的授权。

搜索和读取共用确定性文字投影：字符串正文保持原样；内容块按原顺序以换行分隔，`text` 只取文字，`toolCall` 写为 `工具调用 名称 (ID)` 加换行和 JSON 参数，其他块写为 `[非文字内容已省略]`。`toolResult` 在正文前写入 `工具结果 名称 (ID)`。图片、隐藏思维、协议签名及其他扩展字段不输出。原正文中的频道及可见范围标记不从当前对话状态重建。结果给出记录 `id`、`agentId`、原生记录号 `seq`、`role`、原消息 `timestamp`（Unix 毫秒）及 assistant 的 `toolCalls` 或结果的 `toolCallId` / `toolName` / `isError`。

`history.search({query, cursor?})` 使用大小写敏感的字面子串，不解释正则。空字符串及包含未配对代理字符的查询拒绝。每次按 `seq` 升序扫描最多 100 条，返回最多 20 条，每条只报首个命中。`match` 为完整命中的 `[start,end)`；`excerpt` 带文字和自己的 `[start,end)`，最多 400 个 UTF-16 代码单元，命中前保留最多约 100 单元，边界不切代理对。长查询的命中可超过摘录，应按 ID 续读。所有范围均从投影文字的 0 开始。

首请求固定调用者当时最高消息 `seq`；原样携返回的 `nextCursor` 和同一查询继续，直到 `nextCursor=null`。游标包含 Agent、当前原生 conversation、原查询、固定上界 `through` 和已扫描位置 `after`，不是权限凭证；服务端校验字段类型、非负安全整数、`after<=through`、上界未超出自己的已确认记录，以及 Agent/conversation/查询匹配。空命中但游标非空时仍可继续；命中满 20 条只推进到最后处理的记录，新追加消息需新搜索。

`history.read({id, offset?, maxChars?})` 默认从 0 返回最多 8,000 个 UTF-16 代码单元，`maxChars` 为 2 至 16,000。返回 `text`、`offset`、`nextOffset`、`totalLength` 和当前 conversation 的 `previousId` / `nextId`；按 `nextOffset` 续读不会静默丢失尾部。offset 等于总长度时返回空片段和 `nextOffset=null`，超界或位于代理对中间则拒绝。未知记录 ID 和他人记录 ID 使用同一拒绝。

这些限制是观察分页约束，不是 Agent 运行或用量额度。100 条记录的上限不保证固定 CPU、内存或读取字节成本：巨型原消息仍需读取、解析并构造整个文字投影，分段阅读也有这一成本；首版不引入全文索引或改写原始历史。

当前运行职责见 [ADR-0010](adr/0010-durable-agent-runtime.md)。业务库拒绝旧开发格式：停止服务，保留并移开旧数据目录，再使用账号拥有的新空目录重新初始化（步骤见 [运维说明](OPERATIONS.md)）。不得删除原文件、恢复旧表读取器或把新库覆盖到旧目录。
