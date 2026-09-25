# 本地开发与验证

项目使用 `package.json` 指定的 Node 与 pnpm 版本。依赖、构建和测试以 `package.json`、`pnpm-lock.yaml` 为准；本文件只说明如何运行完整的本地入口。

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm typecheck
```

## 网页状态页与 HTTP 服务

根工作区包含控制面 HTTP 服务，`apps/web` 是 Vite/React 网页。网页和控制面可以分别构建：`pnpm run build:web`、`pnpm run build:control-plane`。完整构建会将网页复制到控制面产物，由 Hono 服务同源提供页面和 API：

控制面状态目录由绝对路径环境变量 `MATE_CONTROL_PLANE_DATA_DIR` 指定。服务在目录中创建自己的 `control-plane.sqlite`，目录权限设为 `0700`，数据库文件设为 `0600`。所有者首次登录前还需设置 `MATE_OWNER_PASSWORD_FILE`，让它指向一个普通文件；该文件必须只有服务账号可读，密码为 12 到 1024 个 UTF-8 字节。服务只在数据库尚无所有者密码哈希时读取该文件，将密码保存为 Argon2id 哈希；哈希存在后启动和登录都不再需要明文文件。控制面进程可通过 systemd credential 等受保护方式取得该文件路径。

空数据库没有密码文件或文件权限不合要求时，登录返回配置错误，私有页面和 API 仍拒绝访问；公开状态页继续可用。网页不会提供未认证的密码初始化入口，也不会生成默认密码。开发时可先建立一个权限为 `0600` 的临时密码文件并设置这两个环境变量：

```sh
export MATE_CONTROL_PLANE_DATA_DIR=/ABSOLUTE/PATH/mate-control
export MATE_OWNER_PASSWORD_FILE=/ABSOLUTE/PATH/owner-password
```

根路径仍显示公开服务状态；`/login` 是所有者登录页，`/app` 及 `/api/owner/*` 需要有效会话。登录 cookie 具有 `Secure`、`HttpOnly`、`SameSite=Lax` 和 `__Host-` 约束；本机浏览器验证请通过 HTTPS 或浏览器认可的 loopback origin。

```sh
pnpm run build
pnpm start:control-plane
```

服务默认只监听 `127.0.0.1:8787`，也可以通过 `MATE_CONTROL_PLANE_PORT` 改端口。浏览器打开 `http://127.0.0.1:8787` 查看中文状态页；公开的 `GET /api/status` 只返回服务是否正在运行。

用真实 Chrome/Chromium 验证 React 页面、API 状态和断连恢复时：

```sh
pnpm run build
pnpm start:control-plane
```

在浏览器打开 `http://127.0.0.1:8787`，页面状态应显示“服务正在运行”。另开终端查看 API：

```sh
curl -i http://127.0.0.1:8787/api/status
```

预期 HTTP 状态码为 `200`，`Content-Type` 为 `application/json`，响应体为 `{"status":"running"}`。保持浏览器页打开，在服务终端按 `Ctrl-C`；页面应在下一次状态检查时显示“暂时无法连接控制面”。重新运行 `pnpm start:control-plane` 后，页面应在下一次检查时回到“服务正在运行”。页面在每次请求结束后等待 10 秒再检查，单次请求最多等待 5 秒。

2026-09-25 的真实 Chrome 验证观察值：页面初次显示“服务正在运行”；控制面停止后显示“暂时无法连接控制面”；同一页面在服务重启后重新显示“服务正在运行”。对应 `GET /api/status` 实际响应为 `HTTP 200`、`Content-Type: application/json`、`{"status":"running"}`。

本地开发时先在一个终端构建并启动控制面，再在另一个终端启动网页：

```sh
pnpm run build
pnpm start:control-plane
```

```sh
pnpm dev:web
```

浏览器打开 `http://127.0.0.1:5173`。Vite 将网页发出的 `/api/status` 请求代理到 `http://127.0.0.1:8787`；需要自定义目标时设置 `MATE_CONTROL_PLANE_ORIGIN`。

普通测试使用合成 Slack/provider 输入。涉及 Linux 用户执行、后台进程和部署的改动还应运行相应的定向测试：

```sh
pnpm exec vitest run tests/execution/linux-user.test.ts tests/execution/linux-processes.test.ts tests/deployment/linux-deployment.test.ts tests/deployment/linux-checkpoint.test.ts tests/deployment/host-operations.test.ts tests/deployment/native-maintenance.test.ts
```

macOS 本地入口不模拟 Linux 用户权限。三类证据不能互相代替，改动相关路径时要说清自己给出的是哪一类：

1. **仓库测试（任何平台）**。用真实 SQLite 和真实文件系统验证当前格式数据的备份、恢复与重启保留（`tests/daemon/checkpoint.test.ts`、`tests/deployment/linux-checkpoint.test.ts`、`tests/daemon/database-preservation.test.ts`），以及用可替换宿主入口验证维护流程（`tests/deployment/host-operations.test.ts`、`tests/helpers/host.ts`）。宿主替换入口是**模拟**宿主：它能证明流程不绕过唯一入口并验证故障注入后的恢复，不能证明真实 UID、目录权限或 systemd 行为。
2. **原生 Linux（可重置的 Debian 13 主机）**。`tests/native/linux-maintenance.sh` 用真实 Agent 账号跑完安装、检查、备份、程序升级、配置变更、重启和恢复，并报告每一项结果；`tests/deployment/native-maintenance.test.ts` 在本机验证它的记录、清单核对和报告格式，并覆盖 `native` 报告必须带宿主事实、`fixture` 运行不能生成 `native` 报告这两条规则。命令见[运维说明](OPERATIONS.md)。这些检查需要 root、systemd 和真实 Agent 账号，在 macOS 开发机上**没有执行**，也不能由本机测试代替。
3. **真实 Slack/provider/VPS 连接**。不进入每个 ticket 的循环，也不能由上面两类结果宣称完成。

`pnpm check` 在开发 checkout 运行；Linux 发布目标还需以目标 Node ABI 执行 `pnpm build`、`pnpm typecheck` 和 `MATE_NATIVE_UID_TEST=1 pnpm exec vitest run tests/execution/linux-user-tools.test.ts`。完整测试集包含使用非 Linux 本地开发夹具的用例，不能把这些夹具在生产 Linux 配置下的失败当作 Agent 隔离结果，也不能用它们代替原生验证。

## 本地双成员入口

复制 [mate.local.example.json](../mate.local.example.json) 为未提交的配置文件，把 `runtime.dataDir` 改为 checkout 外、当前用户可写的绝对目录。示例预配置 `research`、`writer` 和内部 `team-room`；本地入口不需要 Slack 身份。实际模型调用需要配置文件所引用的 provider 环境变量。

```sh
pnpm node dist/src/main.js check mate.local.json
pnpm node dist/src/main.js local mate.local.json
```

`local` 与 Slack 入口使用同一 daemon、会话、工具、消息门控和 owner 控制。它从标准输入逐行读取 JSON，请求的 `id` 对应响应的 `id`；日志写到 stderr。stdin 是可信宿主接口，不是可接受任意用户身份的网络 API。EOF 会关闭 console 和 daemon。

```json
{"id":"rooms","op":"rooms","human":"owner"}
{"id":"send","op":"send","human":"owner","eventId":"unique-request-1","target":{"conversationId":"team-room"},"text":"Investigate this question"}
{"id":"read","op":"read","human":"owner","target":{"conversationId":"team-room"}}
{"id":"status","op":"control","human":"owner","text":"status"}
```

`eventId` 是持久幂等键；同一身份与内容重试返回同一消息，改动内容会被拒绝。回复使用已返回规范消息 ID 作为 `target.threadId`。`read` 每页最多返回 100 条未删除消息，继续读取时将 `nextCursor` 作为 `before`。发送和读取检查当前房间成员资格，控制命令还检查 owner 权限。

本地房间成员资格由配置首次播种；重启不会恢复已撤销的访问。配置变更只需停止后替换配置文件并重启，Mate 会在启动时应用并记录，同时保留已有会话、投递、任务、提醒和身份。要检查恢复，在停止后以相同配置和 `dataDir` 重启，验证消息、session、任务、提醒、草稿、模型用量与 workspace 仍在。普通 assistant 文本是私有的；公开输出必须通过显式消息或成果工具，沉默也可以是有效选择。
