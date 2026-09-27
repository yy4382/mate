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

> **下列 Linux 身份与 systemd 检查只覆盖重构中的旧实现，不是新首版验收要求。** 新目标是在同一个现有普通账号下启动 Mate 和 Agent 命令，不创建用户、不切换身份、不操作 systemd；见[产品方向](PROJECT_DIRECTION.md)。

当前旧 Linux 节点要求 root、`setpriv`、systemd 和 Agent 用户切换。macOS 单元测试和本地网页检查只验证应用逻辑，不构成真实 Linux 权限与进程隔离证据。Debian 13 隔离容器可运行下面的旧身份、文件权限、进程密钥与特权审批检查；测试前先在目标 Linux 架构内运行 `pnpm build`，以生成原生模块和 no-replace helper：

```sh
MATE_AGENT_TEST_SANDBOX=temporary-container node tests/linux/agent-provisioner.integration.mjs
MATE_AGENT_TEST_SANDBOX=temporary-container node tests/linux/agent-workspace-isolation.integration.mjs
node tests/linux/agent-stop-fence.integration.mjs
MATE_MODEL_TEST_SANDBOX=temporary-container node tests/linux/model-worker-isolation.integration.mjs
node tests/linux/privileged-approval.integration.mjs
```

这些脚本只允许在私有 PID、无宿主目录挂载、无网络且非特权的临时容器中运行；模型 worker 环境读取测试需要只授予该容器 `CAP_SYS_PTRACE`。`agent-process-operations.integration.mjs` 需要启动的 systemd 和真实 Agent scope，留给可重置 Debian 主机。`systemd-analyze verify` 只检查生成单元的语法与路径，不代表服务启动、cgroup 管理、Caddy、升级或恢复已通过。把容器结果与原生 Debian 13 验收分别记录，不要把模拟宿主或静态检查标为原生通过。
