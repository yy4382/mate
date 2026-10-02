# 本地开发与验证

已确认的首版包装目标是控制面镜像/Compose 与 node 用户目录完整包、薄 bootstrap、统一 `mate node` CLI 及 systemd 用户服务，见 [ADR-0009](adr/0009-lightweight-linux-packaging.md)；该包装尚未实现。下文记录当前源码构建与真实进程测试，不代表发布包或用户服务已验收。未来包装测试须单独记录 Ubuntu 24.04、Debian 13 的 x86_64/arm64 及真实 bootstrap → 包内 CLI → user manager 证据，包括 CLI 自身和专用 Node 的整包更新；容器不能替代用户服务安装验收。

使用 Node 24 和 pnpm 10.33.0。运行 `pnpm install --frozen-lockfile`、`pnpm check`、`pnpm typecheck`。`pnpm build` 将控制面编译到 `apps/control-plane/dist`、节点编译到 `apps/node/dist`，将网页写入 `apps/web/dist`。节点可单独用 `pnpm build:node` 构建，并通过 `pnpm --filter @mate/node test` 运行本地行为测试。运行环境变量见[配置说明](CONFIGURATION.md)，Linux 上以普通账号直接启动、停止重启与诊断见[运维说明](OPERATIONS.md)。

控制面本地启动需要一个只有当前用户可读的初始密码文件（12–1024 UTF-8 字节）和一个绝对数据目录：

```sh
export MATE_CONTROL_PLANE_DATA_DIR=/ABSOLUTE/private/control-plane
export MATE_OWNER_PASSWORD_FILE=/ABSOLUTE/private/owner-password
pnpm start:control-plane
pnpm dev:web
```

浏览器打开 `http://127.0.0.1:5173`，Vite 将 `/api` 转给本机控制面。PWA 注册和授权入口可在安全的 localhost 上检查；真实公网 Push 送达、域名证书和 Caddy WSS 须在 HTTPS 部署上验证。Web Push 的仓库测试只注入本地伪发送器，验证通知选择、去重、失败不回滚和落点；它不向第三方服务发送通知。

节点启动与配对已按新目标运行：`pnpm start:control-plane` 与 `pnpm start:node` 可在普通账号下直接启动，不需要 root、用户创建或 service manager。节点需要 `MATE_CONTROL_PLANE_URL`；`MATE_NODE_DATA_DIR` 默认为当前目录下的 `data/node`，Agent 工作区根目录默认为节点数据目录下的 `agents`，可用 `MATE_NODE_AGENT_WORKSPACE_ROOT` 覆盖。创建 Agent 也走同一条普通账号路径：节点在运行账号可写的工作区根目录下建立该 Agent 的目录、记忆入口 `MEMORY.md` 和原身份标记，不创建 Linux 账号、不切换 UID/GID。工作区根路径不可写或目标目录已被其他内容占用时，网页按同一请求显示可诊断的失败原因。

```sh
export MATE_CONTROL_PLANE_URL=http://127.0.0.1:8787
export MATE_NODE_DATA_DIR=/ABSOLUTE/private/node
pnpm start:node
```

单账号启动检查以现有普通账号启动控制面与节点，通过真实 WebSocket 配对、创建两名 Agent，分别重启节点和控制面并核对重新认证、在线状态与错误身份拒绝。控制面真实 Pi 循环请求本地脚本化 HTTP/SSE 模型服务，调用节点普通命令并持久保存 transcript；命令实测 UID/GID 和工作目录。脚本核对两名 Agent 独立工作区与 session、`MEMORY.md`、目录权限 `700`，以及没有按 Agent 创建账号。macOS 与 Linux 均可运行，并记录 `kernel`、`hostEnvironment` 与 `linuxKernel`；macOS 结果仅是跨平台证据。工作区不可写的网页失败由 `agent-creation-process.test.ts` 单独覆盖：
```sh
pnpm build
pnpm test:linux-single-account-node
```

工作区与记忆入口接缝另有一个跨平台检查：它不创建 Linux 账号、不要求 root，在同一运行账号下建立两名 Agent 的工作区，核对目录权限、`MEMORY.md`、原身份标记与重试复用，并确认已有内容的目录会被报告而不是被接管：

```sh
pnpm build
pnpm test:single-account-agent-workspace
```

从网页创建 Agent 到首次私信产生模型运行并写入该 Agent 自己的会话记录，由 `apps/control-plane/tests/control-plane/agent-loop.test.ts` 用真实控制面内 Pi 循环、本地 HTTP/SSE provider、WebSocket、节点与持久库覆盖；它在 macOS 与 Linux 上都会运行。数据目录的格式拒绝与日常接续见[运行手册](OPERATIONS.md#数据与日常接续)。

新增真实进程场景可使用 `apps/control-plane/tests/helpers/scenario-environment.ts` 的 `createScenarioEnvironment({ agents, provider, controlPlane, node })`。`agents` 声明合成 Agent 资料；`provider` 沿用现有 `agent-loop.ts` 的 HTTP/SSE handler 与 `respond`；可选的 `controlPlane` 和 `node` 配置指定操作、命令与心跳时限。环境返回前已完成 Owner 登录、真实节点配对、合成模型凭据和 Agent 工作区准备；`agents` 返回实际资料（含 session ID）、Owner 私信频道与工作区。用 `request(path, { method, body })` 驱动真实 Owner API，场景不需要拼启动源码。启动文件 `scenario-services.mjs` 使用本次构建的控制面和节点；子进程以现有账号运行，只有必要变量、合成 HOME/临时目录及程序搜索路径。

每套环境拥有自己的临时目录、模型端口、控制面端口和进程；`restartControl()` 与 `restartNode()` 沿用这些目录和原身份，控制面重启会重新登录并等待节点重新认证。重叠重启会明确报错，等待当前重启完成后可再次调用。始终在 `finally` 中 `await environment.close()`；关闭报告的 `failures` 单独记录，失败的资源保留登记，可再次关闭重试。额外的本场景资源创建后立刻用 `registerCleanup(name, release)` 登记；显示名称不作为内部资源身份。用 `beforeClose(name, collect)` 在服务和文件释放前收集证据，启动失败也需要证据时使用配置的 `beforeClose(facts, signal)`。证据与释放回调均收到 AbortSignal，每项默认有 5 秒上限（可用 `cleanupTimeoutMs` 配置）；回调应响应取消并允许重复释放。失败或超时会记入报告，环境继续尝试其它资源；未确认释放的资源仍保留登记。再次关闭先有界等待上次尚未结束的释放，不同时调用同一回调；上次完成后确认其成功，或在其失败后重试。`observeProcess(service, output)` 提供已登记的真实进程输出，用于事件观察；配置的 AbortSignal 和驱动 SIGINT/SIGTERM 都进入同一清理流程。启动错误 `ScenarioStartupError` 保留原始 `cause`、进程状态、`cleanup` 和全部 `cleanupReports`，其 `close()` 保留失败资源的重试入口。`processes`、`resources`、`cleanupReports` 可用于报告已创建资源与残留，不扫描宿主已有服务。

`scenario-environment.test.ts` 的第一条工具场景是短的可运行使用示例，其余测试覆盖双环境并行隔离、原身份重启、重叠重启拒绝、半途失败、监听前取消、真实信号取消、单项释放失败或超时后重试、资源名称碰撞与环境变量边界。它打印实际平台；macOS 结果是跨平台证据，Linux 结果也不代表真实 provider 或 VPS 已验证：

```sh
pnpm build
pnpm --filter @mate/control-plane exec vitest run tests/control-plane/scenario-environment.test.ts
```

按 Agent 编写模型脚本时，使用 `tests/helpers/scripted-provider.ts` 的 `createScriptedProvider({ timeoutMs })`，把 `handle` 交给同一环境。`forAgent(preparedAgent, steps)` 接收普通的命名 TypeScript 函数；每个 Agent 内步骤名称唯一，供 `waitFor(agentId, stepName)` 等待本步骤的真实请求。脚本按准备好的 session 分路，同 provider/model 的 Agent 不需要不同 model ID。固定测试启动文件只在既有 `modelForRun` 测试依赖中读取 session ID 并改写本地 URL；摘要的独立请求/缓存 ID 不作为 Agent 身份。`controlPlane.modelContextWindow` 只供真实压缩探针缩小测试模型上下文。

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
      request.call("process.exec", { command: "printf 'command-ran' > result.txt; cat result.txt" });
    },
    function inspectRealResult(request: ScriptedRequest) {
      const result = request.result("process.exec", scriptedToolResultSchemas["process.exec"]);
      expect(result.receipt?.stdout).toBe("command-ran");
      request.text("完成。");
    },
  ]);
  await environment.request(`/api/owner/channels/${agent.channelId}/messages`, {
    method: "POST", body: { text: "执行普通命令。" },
  });
  const result = await provider.waitFor(agent.summary.id, "inspectRealResult");
  expect(await result.outcome).toEqual({ kind: "responded" });
  await provider.assertComplete();
} finally {
  await environment.close();
}
```

完整可运行版本在 `scenario-environment.test.ts` 的普通命令场景，导入 `createScriptedProvider`、`ScriptedRequest` 和 `scriptedToolResultSchemas` 后即可使用。`request.text`、`call` 和 `tools` 复用既有 OpenAI Responses SSE；每个响应与工具调用有新的 ID。`request.result(name, schema)` 按实际调用 ID 找到对应结果并用 Zod 解析；常用对话、任务和命令结果投影在 `scripted-tool-results.ts`，其它真实结果可传已有领域 schema。它不制造工具结果或写业务库。

模型请求与步骤默认都在 5 秒内结束；等待命名步骤也有截止时间。暂留响应可让命名步骤直接返回，由驱动拿到请求后调用 `text` 或 `call` 释放。异步步骤应响应 `request.signal`；`assertComplete()` 等待有界步骤收尾，包含等待期间新增的步骤，再拒绝错误、未用步骤或待响应请求。意外请求、脚本耗尽、步骤失败、步骤超时和响应超时会记录含 Agent/session、步骤与实际请求的 `ScriptedProviderError`，没有隐式“完成”兜底。预期客户端取消需先调用 `request.expectCancellation(reason)`，实际 HTTP 关闭后 `outcome` 为 `cancelled`；未声明的取消为失败，框架关闭为 `closed`，待响应超时为 `timeout`。已结束请求再释放返回 `late`，脚本关闭后新请求报告 `late_request`，不会继续执行步骤。`close()` 返回 Promise，登记到环境现有清理入口并在直接调用时等待它。它立即关闭待响应请求，给已经就绪的 Promise 接续一次事件循环机会，按步骤函数的实际返回或 Promise 完成结清收尾，避免把正常回复后的立即关闭误报为中断。已响应但异步代码尚未结束的步骤被关闭时记录 `step_cancelled`，不能因此通过完成检查；随后出现的非取消异常仍记录原始 `cause`。异步代码响应取消时可抛出 `request.signal.reason`，仅该取消原因被视为正常收尾；合成请求与诊断保留在 `requests`/`errors`，可在环境的 `beforeClose` 中读取。

`scripted-provider.test.ts` 用真实 CP/node/Pi/HTTP-SSE 验证同 model 双 Agent 交错、动态任务身份、重复命令调用的正确结果、真实摘要与普通请求分路，以及取消、迟到、耗尽和截止时间。它只用合成模型凭据，不代表真实 provider 或 Linux VPS 已验证：

```sh
pnpm build
pnpm --filter @mate/control-plane exec vitest run tests/control-plane/scripted-provider.test.ts tests/control-plane/scenario-environment.test.ts
```

场景驱动使用 `tests/helpers/scenario-driver.ts` 的 `createScenarioDriver(environment)`。`sendOwnerMessage(agent, text)` 只发送普通 Owner 消息，先记录该 Agent 当前活动游标，返回实际消息、Agent/session 身份和游标。将返回值交给 `waitForRun(target, "completed")`，等待该消息所属 run 的持久关联和游标后的 Owner 运行活动共同成立；已有 completed 不会满足新消息。已取得 run ID 时可传 `{ ...target, runId }`，将等待固定到那一轮。观察即将释放的同伴反馈时，先 `observe(agent)`，再用实际消息工具结果组成 `{ ...observation, message }`。这些关联只是观察条件，不限制 Agent 阅读或行动。

`messages(channelId)` 读取分页主时间线，`thread(channelId, rootId)` 读取根消息及回复，`tasks()`、`attachments(channelId)` 和 `activity(agentId, after)` 分别读取真实 Owner API，并复用协议 schemas；活动投影在读取边界核对现有 `AgentActivityEvent` 契约。`waitForTask` 要求具体 ID、消息锚点、频道、负责人和状态；`waitForMessage` 要求具体 ID、频道、rootId、作者和文字。`assertAttachment({ agent, channelId, attachmentId, path, expectedBytes })` 核对实际上传者、附件元数据以及三份字节：Owner 下载、真实 Agent 工作区文件和独立的合成预期。它们不调用 Agent 工具，也不写业务数据库。消息与 run 的关联仅在 `scenario-facts.ts` 中集中打开只读数据库：run 原始 seed（启动该轮的实际投递）在输入提交前也有明确关联；其它消息须在本轮入参上界内，且有该 seed 对应操作范围中由本轮或更早轮实际提交的投递 ID。恢复保留原范围和已确认上下文，但后续轮才提交的新输入不会回填到旧轮。提醒轮没有实际接收的普通消息不会因序号范围重叠而误归属。查询不以任意非空行表示成功，也不替代实际模型请求中的上下文断言。手动暂停只有 Agent 级活动，因此 failed 等待核对该轮持久失败状态和原启动活动；completed 还必须有该轮的 Owner 完成活动。

条件等待共用 `waitForScenario(label, read, matches, { timeoutMs, signal })`，默认 5 秒；截止时间覆盖读取本身和轮询间隔，取消信号也传给 Owner HTTP 请求。条件未成立、读取失败和取消都抛出带原始 `cause` 的 `ScenarioWaitError`，含等待标签和 `lastFacts`（最后一次完整观察；尚无观察时为 `undefined`）。`scenario-driver.test.ts` 的短单 Agent 报告是完整可运行样例：先完成 R1，再发新的 Owner 普通消息，由 R2 自己读取、创建/认领任务、用真实普通命令生成总计 12 的文件、发布附件、显式回复原请求并完成任务。反例覆盖旧消息/游标、错误 run ID、错误负责人/作者、真实事件流停滞与取消，以及 run 已结束但任务仍在进行中。提醒与普通消息同批场景核对各实际请求中的输入；seed 输入提交前的控制面 SIGKILL 场景复用既有 `loopFixture` 提交钩子，验证旧轮中断与同 session 的新轮恢复。后到消息，以及原已同批但尚未提交的消息，都验证后续恢复提交不会反向归属旧轮。新增场景只需描述模型步骤、输入和预期成果：

```sh
pnpm build
pnpm --filter @mate/control-plane exec vitest run tests/control-plane/scenario-driver.test.ts
```

`message-tasks.test.ts` 沿用这些真实进程和持久库，验证消息及回复的多任务、两位 Agent 的明确认领与并发新增、消息草稿交错。任务提交后模型结果尚未确认时的控制面重启场景已迁移到下文的 `cp-recovery-scenarios.test.ts`。模型输出由本地脚本 provider 指定，只验收工具和恢复能力；它不代表真实模型服务连接或 VPS 部署已验证。中文网页的标题输入和全部关联任务展示由 `apps/web/tests/chat-app.test.ts` 的现有交互接缝覆盖。

```sh
pnpm build
pnpm --filter @mate/control-plane exec vitest run tests/control-plane/message-tasks.test.ts
pnpm --filter @mate/web exec vitest run tests/chat-app.test.ts
```

普通命令执行在同一个现有普通账号下运行：Agent 的命令进入当前账号的 shell 子进程，默认使用该 Agent 的工作区，返回有界输出、退出码、截断与超时标记，命令里的 `sudo` 原样交给宿主。`agent-loop.test.ts`、`agent-loop-recovery.test.ts` 和 `agent-tool-invalidation.test.ts` 在真实控制面内 Pi 循环、WebSocket 和节点中核对命令/文件工具、控制面提交边界、节点重启收据复用与未知结果。`agent-loop-lifecycle.test.ts` 核对模型/摘要停滞时取消、凭据暂停、离线和同节点多 Agent 并发；`agent-loop-attention.test.ts` 核对忙时主动读取、暂缓、继续、下一轮同 session 与发言新鲜度选择：

```sh
pnpm build
pnpm --filter @mate/control-plane exec vitest run tests/control-plane/agent-loop.test.ts tests/control-plane/agent-loop-recovery.test.ts tests/control-plane/agent-tool-invalidation.test.ts
```

命令的失败与恢复语义另有一个只做真实进程工作的检查：它用真实 shell 子进程跑一条超时命令，模拟节点进程在命令运行中消失，再用同一份收据数据库把节点"重启"，确认同一操作 ID 重放记录而不是重跑命令：

```sh
pnpm build
pnpm test:linux-ordinary-command-failure
```

该检查以启动账号运行，不需要 root、容器或服务管理器，macOS 与 Linux 都可运行，并打印一行 JSON 证据；它记录 `kernel`、`linuxKernel` 与 `containerized`。它不覆盖宿主的 `sudo` 策略：普通账号无法终止 `sudo` 派生的 root 后代，Mate 对此不作任何声明。

`apps/node/tests/files/same-account-files.test.ts` 与 `apps/node/tests/provisioning/agent-workspace.test.ts` 覆盖文件工具在普通账号下的执行、工作区准备，以及节点以 root 运行时拒绝报告运行账号。`apps/control-plane/tests/control-plane/agents.test.ts` 覆盖控制面拒绝以 root 账号完成的 Agent 创建。**不要再引入以 root 运行节点、按 Agent 创建 Linux 账号或按命令创建 systemd 单元的检查**：这些旧路径已移除。ADR-0009 的 由统一 CLI 管理的 node 用户服务是有限包装范围，不是 Agent 执行路径。

# Agent token 与缓存统计

所有者登录后，可携带登录 Cookie 请求 `GET /api/owner/agents/{agentId}/usage`。接口只读取指定 Agent 已由控制面确认的模型响应；Agent 不存在返回 404，未登录返回 401。响应设置 `Cache-Control: no-store`，不提供网页面板。

响应中的 `total`、`normal`、`summary` 分别是全部请求、普通请求和会话压缩摘要请求的累计；`latestNormal` 是最后一次普通请求的记录 ID、控制面确认时间 `recordedAt`（Unix 毫秒）和该次统计。没有普通请求时 `latestNormal` 为 `null`。失败响应只要返回并被确认，其实际报告的用量也计入；失败摘要不因此成为有效压缩。

每组的 `requestCount` 是已确认的模型响应数。`tokens` 分别列出 `uncachedInput`（未缓存输入）、`cacheRead`（缓存读取）、`cacheWrite`（缓存写入）、`allInput`（前三者之和）、`output`、`total`（全部输入加输出）和 `reasoningOutput`（若报告，是输出的子集，不再加到总数）。每个指标包含 `value`、`knownRequests` 和 `missingRequests`：只汇总供应商字段足以确定的请求；没有可确定的值时 `value` 为 `null`，真实零则为 `0`。供应商只报告包含缓存的输入时，不再次把缓存读取量加上去。

`cacheHitRate.value` 是具备完整缓存读取量及全部输入量、且全部输入大于零的同一组请求中，缓存读取 token 总数除以全部输入 token 总数。它是 token 加权的比例，缓存写入进入分母而不算命中，输出不进入分母。`knownRequests` 与 `missingRequests` 显示该比例覆盖了多少请求；缺字段或分母为零的请求不进入比例。没有请求、字段缺失或分母为零时比例为 `null`。这些数字只覆盖控制面收到并确认的响应，不估计供应商侧未送达的计费记录，也不构成用量或运行额度。

Pi 当前的 Google SDK 适配器不开放响应体截取，并把未报告的字段归一成零。Mate 对这一路径只将 Pi 返回的正值视为已报告；归一化零仍显示为未知，不能据此声称 Google 的缓存命中率为 0%。

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

`tests/providers/active-check.test.ts` 用本地合成 HTTP/SSE 服务验证真实 Pi 的文本、工具关联/续接、模型未调用、Anthropic/Google 拒绝与不完整协议的区别、空调用 ID、重复工具、HTTP 拒绝、截流与取消，以及 CLI 缺凭据行为。注入合成服务的结果始终标记 `connection: "synthetic"`；所有者入口标记 `connection: "real"`，仍须同时有 `status: "passed"` 才能算本次真实连接验证通过。合成验证不会自动触发真实调用。当前真实 provider 结果应单独报告，未配置/未调用时写“未验证”。

## 场景失败证据与独立回收

新增场景可用 `tests/helpers/scenario-evidence.ts` 的 `runScenario({ name, provider, environment, run })` 包住整套工作。`provider` 是 `createScriptedProvider()` 的返回值，`environment` 直接沿用环境配置；`run` 收到已就绪的 `environment`、同一个 `driver`、取消 `signal`、`step(name, action)` 和 `effectFile(name, workspacePath)`。`step` 执行普通函数、保留实际返回事实并记录通过／失败；`effectFile` 只登记本场景 Agent 工作区中的具体合成成果，不复制目录、数据库或用户文件。`scenario-evidence.test.ts` 的第一条短报告场景是可运行例子；完整 workflow 可直接沿用此入口。

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
pnpm --filter @mate/control-plane exec vitest run tests/control-plane/scenario-evidence.test.ts
```

该文件覆盖短真实命令场景的断言失败、无法达到事件的超时、真实 SIGINT／SIGTERM、保存与单项释放同时失败、采集 API 停滞、半途启动失败、合成凭据排除，完整公共讨论串和 node 收据，以及杀死实际驱动后（包括运行目录已缺失）独立回收和再次运行。退出竞态回归用 `cc` 编译一个小型临时 holder，通过 `waitid(WNOWAIT)` 保留真实已退出 Node 的 PID，再验证回收器读取 `Z` 状态且不发送信号；另一个真实 Node 连接重试场景验证准备期间终止 holder 也终止并回收其直接子进程。测试失败保留首错、初始报告和路径，收尾错误单独报告；通过后删除本次临时文件。它只用本地脚本模型；macOS 结果是跨平台证据，不替代 Linux CI、真实 provider 或 VPS 验证。

## 新增正常工作场景

在 `apps/control-plane/tests/control-plane/` 新建普通 Vitest 测试，复用 `runScenario`；只写本场景的 Agent 配置、命名模型步骤、Owner 输入和成果断言。短单 Agent 样例可从 `scenario-evidence.test.ts` 的第一条真实报告测试开始，其核心用法如下（导入路径相对于这个测试目录）：

```ts
import assert from "node:assert/strict";
import { join } from "node:path";
import { it } from "vitest";
import { runScenario } from "../helpers/scenario-evidence.js";
import { createScriptedProvider } from "../helpers/scripted-provider.js";
import { scriptedToolResultSchemas } from "../helpers/scripted-tool-results.js";

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

完整双 Agent 样例的模型步骤与成果断言在 `tests/scenarios/report-workflow.ts`，测试入口在 `tests/control-plane/report-workflow.test.ts`。入口仍只有 `runScenario({ name, provider, environment, run })`，`environment.agents` 使用导出的 `reportWorkflowAgents`，`run` 调用 `runReportWorkflow(context, provider)`。因此其它交付拓扑可以复用同一函数及现有 `ScenarioContext`，无需复制启动、SSE、等待或证据逻辑；本样例不增加通用适配平台。

Owner 发送普通请求后，甲实际创建并认领主任务，写入 2、4、6，用普通命令生成含总计 12 的草稿，再发现乙、建立 peer DM、发布草稿附件并发送带 `asTask` 的独立复核请求。脚本只暂留乙的真实 HTTP 响应；驱动确认甲 R1 已结束且主任务仍在进行后释放。乙读取附件原字节，通过工作区工具保存到自己的文件，再用命令实际读取并校验；乙在原复核讨论串反馈记录数 3，完成自己的任务。

实际反馈触发甲 R2；模型请求保留 R1 的有序前缀，甲读取复核讨论串后修订文件，在 Owner 原请求讨论串显式交付，并完成主任务。断言核对 Owner 下载、甲最终文件与预期字节相等，乙校验文件与已发布草稿字节相等，两个任务各自的锚点／负责人／状态，以及甲跨两个 DM、讨论串和两次 run 的同一 session、乙的独立 session、每 Agent 至多一个 current run。任务设为 done 时 run 仍在进行，普通模型正文仍只在会话中；结束 run 后再核对成果。复核只是本样例的自主协作选择，不是产品强制流程或父子任务。

```sh
pnpm build
pnpm --filter @mate/control-plane exec vitest run tests/control-plane/report-workflow.test.ts
```

这条测试也由 `pnpm check` 收录。失败沿同一个证据与清理入口报告实际步骤和关联事实；只使用合成模型和文件，实际平台以执行结果为准，真实 provider、Linux CI、容器和 VPS 各自验证。

## 控制面提交与重启恢复场景

`cp-recovery-scenarios.test.ts` 把既有 CP 提交、压缩、任务结果、部分 SSE 和正常关停用例迁移到同一个 `runScenario`。每条场景使用下面的 ID；失败证据、模型步骤、真实平台/SHA、进程输出与退出、原消息/run/session/operation、API 与效果文件沿既有证据机制保存。迁移后原 `agent-loop-recovery.test.ts` 只保留工作区身份与拒绝提交测试；`message-tasks.test.ts` 保留其它任务行为，避免重复运行同一恢复矩阵。

| 场景 ID | 确定的事件和主要证据 | 覆盖来源 |
| --- | --- | --- |
| `cp-assistant-before` / `cp-assistant-after` | 完整 assistant 提交前/后暂停，SIGKILL 的真实退出，恢复请求的已确认有序前缀与一次命令效果 | 迁移既有提交钩子用例，增加原消息/run 关联 |
| `cp-result-before` / `cp-result-after` | 命令效果及收据已有、toolResult 未提交/已提交；恢复仅复用原 operation，旧 run 中断 | 迁移既有结果边界，并明确结果已提交但 run 未完成 |
| `cp-task-result-before` | 创建任务的事务已提交、toolResult 未确认；实际模型收到原收据，ID/锚点/创建活动保留，显式认领及随后新建任务仍可用 | 迁移既有消息任务恢复用例 |
| `cp-compacted-pending-tool` / `cp-compacted-finish` | 已确认摘要和保留历史存在，待工具调用/完整结束之后 SIGKILL；恢复及后续实际请求保留同一摘要与保留前缀，不重附被摘要覆盖的 seed | 迁移既有两条压缩恢复用例，并补恢复请求证明 |
| `cp-partial-sse` | Pi 实际收到工具参数 delta 后 SIGKILL；取消及恢复完成后，半条消息没有入库/进入上下文，没有派发工具 | 迁移既有部分 SSE 用例，补 Pi 收到片段的事件 |
| `cp-sigterm-command` | 文件证明真实命令已经产生效果；CP 收到 SIGTERM 并正常退出、node 与命令 PID 仍存活，测试明确放行命令后晚到收据按原 operation 对账；真实对话工具读取更正消息，后续 run 按该消息关联等待 | 迁移既有正常关停用例，以条件门替代固定 sleep |
| `cp-manual-pause` | Owner API 暂停实际待响应模型；重启和重新认证后 pausedReason 仍为 manual 且无 current run，显式恢复后沿原 session 完成 | 新增 CP 重启的暂停组合 |

```sh
pnpm build
pnpm --filter @mate/control-plane exec vitest run tests/control-plane/cp-recovery-scenarios.test.ts
```

新增 CP 场景仍声明普通结构化配置。`controlPlane.commitBoundary` 使用 `{ phase: "before" | "after", role: "assistant" | "toolResult", toolName? }` 或 `{ phase: "finish" }`；固定测试启动器通过现有提交依赖暂停一次，15 秒未打断则失败。一次性标记位于本场景临时目录，重启不再次暂停，重启启动器不重新注入提交故障。`restartControl("SIGKILL")` 明确崩溃；默认 `restartControl("SIGTERM")` 走正常关停，两者记录实际退出状态。`controlPlane.observePartialTool` 仅通过已有测试依赖容器中的观测回调报告真实 Pi 工具参数 delta，不新增生产配置或故障 API。脚本的 `partialTool(argumentsPrefix)` 发送未完成 SSE 并保持待响应，需先声明预期取消。

`tests/scenarios/cp-restart.ts` 导出选定的 `runCpRestart(context, provider)`，默认复用 assistant 已提交但尚未派发命令的边界，供容器拓扑沿用同一模型脚本、成果与原身份断言。`scenario-recovery-facts.ts` 集中只读查询 Owner API 没有暴露的 transcript、原 run、操作与工具收据；任务、活动、模型请求和文件仍为主要成果证据。这些场景加入 `pnpm check`；本地 macOS 结果不能代替实际 Linux CI、镜像、真实 provider 或 VPS 验证。
