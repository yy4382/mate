# 本地开发与验证

使用 Node 24 和 pnpm 10.33.0。运行 `pnpm install --frozen-lockfile`、`pnpm check`、`pnpm typecheck`。`pnpm build` 将控制面与节点编译到 `dist/src`，将网页写入 `dist/web`。首版部署配置见[配置说明](CONFIGURATION.md)，Debian 13 上以普通账号启动、诊断、备份与升级见[运维说明](OPERATIONS.md)。

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

单账号启动检查以启动账号运行，不需要 root、容器或服务管理器，也不需要预建 Mate 专用用户；它在同一个脚本里启动控制面与节点，通过真实 WebSocket 完成一次性配对，从网页接口创建两名 Agent，分别在重启节点与重启控制面（节点保持在线）之后确认已配对节点重新认证，从网页读取的同一接口核对在线/离线与错误凭据被拒绝，并确认短期模型子进程与启动账号相同。它记录的证据包括：脚本本身以非 root 的启动账号运行、两名 Agent 的账号就是启动账号（用户名与 UID 由脚本实测得出）、两名 Agent 工作区与会话各自独立、记忆入口可用、工作区权限为 `700`、写入模型凭据后网页显示 `ready`；在能读取本机 passwd 数据库的主机上，它还会直接查证旧版按 Agent 建立的 `mate_<27 位 Agent ID>` 账号并未出现（`localAccountDatabaseRead` 为 false 时该项记为 `null`，不作断言）。macOS 与 Linux 均可运行；脚本会记录 `hostEnvironment` 与 `linuxKernel`。同一脚本还可在节点启动模型进程的接缝处核对模型子进程账号；工作区根路径不可写时网页显示失败原因，由 `tests/control-plane/agent-creation-process.test.ts` 中的独立用例覆盖，不在此脚本内：

```sh
pnpm build
pnpm test:linux-single-account-node
```

工作区与记忆入口接缝另有一个跨平台检查：它不创建 Linux 账号、不要求 root，在同一运行账号下建立两名 Agent 的工作区，核对目录权限、`MEMORY.md`、原身份标记与重试复用，并确认已有内容的目录会被报告而不是被接管：

```sh
pnpm build
pnpm test:single-account-agent-workspace
```

从网页创建 Agent 到首次私信产生模型运行并写入该 Agent 自己的会话记录，由 `tests/control-plane/agent-creation-process.test.ts` 用真实控制面、WebSocket、节点与脚本化模型覆盖；它在 macOS 与 Linux 上都会运行。数据目录与发布版本的兼容边界见 [运行手册的升级与回退](OPERATIONS.md#升级与回退)。

普通命令执行在同一个现有普通账号下运行：Agent 的命令进入当前账号的 shell 子进程，默认使用该 Agent 的工作区，返回有界输出、退出码、截断与超时标记，命令里的 `sudo` 原样交给宿主。`tests/control-plane/agent-command-process.test.ts` 用真实控制面、WebSocket、节点和脚本化模型在 macOS 与 Linux 上核对这条路径、同一操作 ID 的收据复用，以及节点在命令运行中被重启后不再执行同一动作：

```sh
pnpm build
pnpm vitest run tests/control-plane/agent-command-process.test.ts
```

命令的失败与恢复语义另有一个只做真实进程工作的检查：它用真实 shell 子进程跑一条超时命令，模拟节点进程在命令运行中消失，再用同一份收据数据库把节点"重启"，确认同一操作 ID 重放记录而不是重跑命令：

```sh
pnpm build
pnpm test:linux-ordinary-command-failure
```

该检查以启动账号运行，不需要 root、容器或服务管理器，macOS 与 Linux 都可运行，并打印一行 JSON 证据；它记录 `kernel`、`linuxKernel` 与 `containerized`。它不覆盖宿主的 `sudo` 策略：普通账号无法终止 `sudo` 派生的 root 后代，Mate 对此不作任何声明。

部署路径（登记发布目录、启动/停止/重启两个服务、状态与诊断、备份恢复、升级）由 `tests/deployment/account-services.test.ts` 与 `tests/deployment/coordinated-cli.test.ts` 覆盖：前者真的启动、重启和停止子进程并核对进程号与日志，后者核对命令路由。整条路径（一条命令启动两个服务、重启、状态、登录、配对、创建 Agent、执行一条普通命令）在下面这个只做真实进程工作的检查里以启动账号跑完：

```sh
pnpm build
pnpm test:linux-single-account-deployment
```

它以启动账号运行，不需要 root、容器或服务管理器，并打印一行 JSON 证据，记录 `kernel`、`linuxKernel`、`hostEnvironment` 与 `hostEnvironmentMarker`；证据里还包含 `commandsExercised`、`restartReplacedBothProcesses`、`controlPlaneHttpProbe`、`ordinaryCommandRanInAgentWorkspace` 等字段，便于逐项核对。该检查用 `MATE_NODE_MODEL_WORKER_ENTRY` 指向脚本化模型进程，从而在没有模型凭据的情况下观察一条真实普通命令；这个环境变量是节点启动模型进程的测试接缝，真实部署不设置它。

`tests/execution/same-account-files.test.ts` 与 `tests/nodes/agent-provisioner.test.ts` 覆盖文件工具在普通账号下的执行、工作区准备，以及节点以 root 运行时拒绝报告运行账号。`tests/control-plane/agents.test.ts` 覆盖控制面拒绝以 root 账号完成的 Agent 创建。**不要再引入以 root 运行节点、按 Agent 创建 Linux 账号或 Mate 管理 systemd 单元的检查**：这条路径已从实现、配置和说明中移除。

# Agent token 与缓存统计

所有者登录后，可携带登录 Cookie 请求 `GET /api/owner/agents/{agentId}/usage`。接口只读取指定 Agent 已由控制面确认的模型响应；Agent 不存在返回 404，未登录返回 401。响应设置 `Cache-Control: no-store`，不提供网页面板。

响应中的 `total`、`normal`、`summary` 分别是全部请求、普通请求和会话压缩摘要请求的累计；`latestNormal` 是最后一次普通请求的记录 ID、控制面确认时间 `recordedAt`（Unix 毫秒）和该次统计。没有普通请求时 `latestNormal` 为 `null`。失败响应只要返回并被确认，其实际报告的用量也计入；失败摘要不因此成为有效压缩。

每组的 `requestCount` 是已确认的模型响应数。`tokens` 分别列出 `uncachedInput`（未缓存输入）、`cacheRead`（缓存读取）、`cacheWrite`（缓存写入）、`allInput`（前三者之和）、`output`、`total`（全部输入加输出）和 `reasoningOutput`（若报告，是输出的子集，不再加到总数）。每个指标包含 `value`、`knownRequests` 和 `missingRequests`：只汇总供应商字段足以确定的请求；没有可确定的值时 `value` 为 `null`，真实零则为 `0`。供应商只报告包含缓存的输入时，不再次把缓存读取量加上去。

`cacheHitRate.value` 是具备完整缓存读取量及全部输入量、且全部输入大于零的同一组请求中，缓存读取 token 总数除以全部输入 token 总数。它是 token 加权的比例，缓存写入进入分母而不算命中，输出不进入分母。`knownRequests` 与 `missingRequests` 显示该比例覆盖了多少请求；缺字段或分母为零的请求不进入比例。没有请求、字段缺失或分母为零时比例为 `null`。这些数字只覆盖控制面收到并确认的响应，不估计供应商侧未送达的计费记录，也不构成用量或运行额度。

Pi 当前的 Google SDK 适配器不开放响应体截取，并把未报告的字段归一成零。Mate 对这一路径只将 Pi 返回的正值视为已报告；归一化零仍显示为未知，不能据此声称 Google 的缓存命中率为 0%。
