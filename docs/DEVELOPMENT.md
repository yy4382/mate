# 本地开发与验证

使用 Node 24 和 pnpm 10.33.0。运行 `pnpm install --frozen-lockfile`、`pnpm check`、`pnpm typecheck`。`pnpm build` 将控制面与节点编译到 `dist/src`，将网页写入 `dist/web`。首版部署配置见[配置说明](CONFIGURATION.md)，Debian 13 的服务与 Caddy 安装见[运维说明](OPERATIONS.md)。

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

单账号启动检查以启动账号运行，不需要 root、容器或服务管理器，也不需要预建 Mate 专用用户；它在同一个脚本里启动控制面与节点，通过真实 WebSocket 完成一次性配对，从网页接口创建两名 Agent，分别在重启节点与重启控制面（节点保持在线）之后确认已配对节点重新认证，从网页读取的同一接口核对在线/离线与错误凭据被拒绝，并确认短期模型子进程与启动账号相同。它记录的证据包括：脚本本身以非 root 的启动账号运行、两名 Agent 的账号就是启动账号（用户名与 UID 由脚本实测得出）、两名 Agent 工作区与会话各自独立、记忆入口可用、工作区权限为 `700`、写入模型凭据后网页显示 `ready`；在能读取本机 passwd 数据库的主机上，它还会直接查证旧版按 Agent 建立的 `mate_<27 位 Agent ID>` 账号并未出现（`localAccountDatabaseRead` 为 false 时该项记为 `null`，不作断言）。macOS 与 Linux 均可运行；脚本会记录 `hostEnvironment` 与 `linuxKernel`，macOS 和容器内的结果只作跨平台证据，原生主机结果须单独记录。同一脚本还可在节点启动模型进程的接缝处核对模型子进程账号；工作区根路径不可写时网页显示失败原因，由 `tests/control-plane/agent-creation-process.test.ts` 中的独立用例覆盖，不在此脚本内：

```sh
pnpm build
pnpm test:linux-single-account-node
```

工作区与记忆入口接缝另有一个跨平台检查：它不创建 Linux 账号、不要求 root，在同一运行账号下建立两名 Agent 的工作区，核对目录权限、`MEMORY.md`、原身份标记与重试复用，并确认已有内容的目录会被报告而不是被接管：

```sh
pnpm build
pnpm test:single-account-agent-workspace
```

从网页创建 Agent 到首次私信产生模型运行并写入该 Agent 自己的会话记录，由 `tests/control-plane/agent-creation-process.test.ts` 用真实控制面、WebSocket、节点与脚本化模型覆盖；它在 macOS 与 Linux 上都会运行。控制面数据库从旧格式升级到当前格式时（第 24 版重建单账号 Agent 表，第 25 版删除已废弃的特权审批表），节点上已有的每 Agent 账号记录会被清空并回到「等待准备」，旧失败原因一并清除；该 Agent 需要按同一请求在节点上重新准备一次工作区。若节点上还留着旧版按 Agent 建立的 home（`<工作区根>/<Agent ID>`，内含旧标记 `.mate-home-id`），重新准备会报告该目录已被其他内容占用；把旧 home 移开或改用新的工作区根目录后再重试，而不是期待旧账号或旧 home 继续可用。

> **本节剩余检查只覆盖重构中的旧实现，不是新首版验收要求。** 新目标是在同一个现有普通账号下启动 Mate 和 Agent 命令，不创建用户、不切换身份、不操作 systemd；见[产品方向](PROJECT_DIRECTION.md)。

普通命令执行已经在同一个现有普通账号下完成迁移：Agent 的命令进入当前账号的 shell 子进程，默认使用该 Agent 的工作区，返回有界输出、退出码、截断与超时标记，命令里的 `sudo` 原样交给宿主。`tests/control-plane/agent-command-process.test.ts` 用真实控制面、WebSocket、节点和脚本化模型在 macOS 与 Linux 上核对这条路径、同一操作 ID 的收据复用，以及节点在命令运行中被重启后不再执行同一动作：

```sh
pnpm build
pnpm vitest run tests/control-plane/agent-command-process.test.ts
```

命令的失败与恢复语义另有一个只做真实进程工作的检查：它用真实 shell 子进程跑一条超时命令，模拟节点进程在命令运行中消失，再用同一份收据数据库把节点"重启"，确认同一操作 ID 重放记录而不是重跑命令：

```sh
pnpm build
pnpm test:linux-ordinary-command-failure
```

该检查以启动账号运行，不需要 root、容器或服务管理器，macOS 与 Linux 都可运行，并打印一行 JSON 证据；它记录 `kernel`、`linuxKernel` 与 `containerized`，因此 macOS 结果只作跨平台证据，原生 Linux 结果须单独记录。它不覆盖宿主的 `sudo` 策略：普通账号无法终止 `sudo` 派生的 root 后代，Mate 对此不作任何声明。

尚未迁移的 root 与 systemd 部署路径仍要求特权环境。macOS 单元测试和本地网页检查只验证应用逻辑，不构成真实 Linux 权限与进程隔离证据。Debian 13 隔离容器可运行下面的节点收据 fence；测试前先在目标 Linux 架构内运行 `pnpm build`，以生成原生模块和 no-replace helper：

```sh
node tests/linux/agent-stop-fence.integration.mjs
```

这些脚本只允许在私有 PID、无宿主目录挂载、无网络且非特权的临时容器中运行。`systemd-analyze verify` 只检查生成单元的语法与路径，不代表服务启动、cgroup 管理、Caddy、升级或恢复已通过。把容器结果与原生 Debian 13 验收分别记录，不要把模拟宿主或静态检查标为原生通过。
