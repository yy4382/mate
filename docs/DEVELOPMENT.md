# 本地开发与验证

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

`message-tasks.test.ts` 沿用这些真实进程和持久库，验证消息及回复的多任务、两位 Agent 的明确认领与并发新增、消息草稿交错，以及任务提交后模型结果尚未确认时的控制面重启。模型输出由本地脚本 provider 指定，只验收工具和恢复能力；它不代表真实模型服务连接或 VPS 部署已验证。中文网页的标题输入和全部关联任务展示由 `apps/web/tests/chat-app.test.ts` 的现有交互接缝覆盖。

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

`apps/node/tests/files/same-account-files.test.ts` 与 `apps/node/tests/provisioning/agent-workspace.test.ts` 覆盖文件工具在普通账号下的执行、工作区准备，以及节点以 root 运行时拒绝报告运行账号。`apps/control-plane/tests/control-plane/agents.test.ts` 覆盖控制面拒绝以 root 账号完成的 Agent 创建。**不要再引入以 root 运行节点、按 Agent 创建 Linux 账号或 Mate 管理 systemd 单元的检查**：这条路径已从实现、配置和说明中移除。

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
