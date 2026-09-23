# Debian 13 / systemd 运维手册

适用范围：x86_64 Debian 13、系统级 Docker、Node 24、pnpm 10.33.0。首次安装复用 [DEPLOYMENT.md](DEPLOYMENT.md) 的 installer；升级使用 V2d controller。改变 Agent 集合、workspace/mount/backing、service unit 或 Docker 安全拓扑不属于原地升级支持范围。以下是操作说明，本地测试不会执行外部安装、启动 Slack 或访问 VPS。

## 正常构建与安装

1. 通过发行版的正常 APT 安装途径准备 `git ca-certificates curl gnupg build-essential python3 pkg-config libsqlite3-dev e2fsprogs util-linux systemd`；通过 [Docker Debian 安装说明](https://docs.docker.com/engine/install/debian/) 配置系统 Docker。预先构建或拉取正式 sandbox image，配置使用其完整 sha256 image ID。不要使用 rootless/临时 Docker socket 替代正式环境。
2. 使用可信的软件包渠道正常安装 Node 24（例如 [NodeSource Debian 安装说明](https://github.com/nodesource/distributions) 的 24.x APT repository）；确认 `/usr/bin/node --version` 是 24.x，`/usr/bin/node -p process.arch` 是 `x64`。系统服务固定使用 `/usr/bin/node`，用户 shell 中的版本管理器不替代它。不要解包 `.deb` 后拼接库路径或复制某台开发机的 native addon。
3. 用 Node 安装随附的 npm **仅引导安装包管理器**：`sudo npm install --global pnpm@10.33.0`。项目依赖和测试统一使用 pnpm；不生成 npm lockfile。确认 `pnpm --version` 为 10.33.0。
4. 在完整、已审阅的源码 checkout 中执行以下命令。构建时 Node 必须与目标系统 `/usr/bin/node` 的版本及 ABI 一致。生产目录必须全新；同名目录已存在时换新目录，不在旧发布上覆盖安装。

```sh
MATE_COMMIT=$(git rev-parse HEAD)
pnpm install --frozen-lockfile
pnpm test
install -d -m 0755 /var/tmp/mate-release
cp package.json pnpm-lock.yaml /var/tmp/mate-release/
cp -a dist /var/tmp/mate-release/
(cd /var/tmp/mate-release && pnpm install --prod --frozen-lockfile --package-import-method=copy)
pnpm --silent run deploy release-manifest /var/tmp/mate-release "$MATE_COMMIT" > /var/tmp/mate-RELEASE.json
mv /var/tmp/mate-RELEASE.json /var/tmp/mate-release/RELEASE.json
```

`pnpm test` 包含正式 TypeScript 构建；production install 保留完整正式依赖，并按项目 `onlyBuiltDependencies` 构建 `better-sqlite3` / `fs-ext`。copy import 防止 pnpm store 的外部 hardlink 违反不可变 release inventory。`release-manifest` 复用正式 release inventory/校验边界，覆盖 dist、lockfile、node_modules 和 native addons；不能只传 verifier 文件，也不能手工删除依赖。工作树必须干净且 commit 与构建源码一致。

首次安装前创建专用无登录系统账户（若已存在先核对其身份，不覆盖）：`sudo adduser --system --group --home /var/lib/mate --no-create-home --shell /usr/sbin/nologin mate`。不把 mate 永久加入 docker 组。installer 创建环境文件；可以先保持为空，此时普通 doctor 将明确报告缺失 secret，安装时的离线 candidate 检查允许缺失。

首次安装：按 [部署说明](DEPLOYMENT.md) 准备 config 和 spec，`release.source` 指向上述完整目录，`gitCommit` 填对应 commit；执行 plan/preflight/install。root 命令可使用 `/usr/bin/node /ABSOLUTE/SOURCE/dist/src/deployment/cli.js` 替代依赖 sudo PATH 的 pnpm 包装。首次 installer 不启动服务。

## Slack：每位 Agent 一套 App

配置能力来自 [capabilities.ts](../src/slack/capabilities.ts)：SDK 方法、事件订阅和 `/team` command 共用注册表；运行时读取相同 command/wire-event 常量，OAuth 自检读取相同 scopes 集合。测试扫描 adapter 的 SDK 调用，防止新增调用忘记更新能力表。

为每个 Agent 生成独立 manifest（不需要任何凭证，也不联网）：

```sh
pnpm --silent run deploy slack-manifest research > /var/tmp/mate-research-slack.json
pnpm --silent run deploy slack-manifest writer > /var/tmp/mate-writer-slack.json
```

在 Slack 创建 App 时导入对应 JSON。每个 Agent 独立 App/bot 安装绑定到同一个目标 workspace；记录真实 `teamId`、`slackAppId`、`slackBotId`、`slackUserId`，按 `mate.example.json` 填写 binding，不能共享一个 bot 身份来代表多个 Agent。manifest 设置 Socket Mode、全部 bot events、`/team` 和 bot OAuth scopes，包括 `commands`、聊天、会话历史/成员与文件能力。完整权限清单以生成文件为准，不在本手册维护第二份静态列表。[Slack manifest 规范](https://docs.slack.dev/reference/app-manifest/)

在每个 App 的 Basic Information → App-Level Tokens 中创建 **仅 `connections:write`** 的 app-level token（`xapp-…`），另行安装 App 到 workspace，取得 bot token（`xoxb-…`）。App token 不替代 bot token，也不放入 bot OAuth scopes。Socket Mode 不需要公开 HTTP request URL。[Socket Mode 配置](https://docs.slack.dev/apis/events-api/using-socket-mode/)

启用 App Home 的 Messages tab，并允许用户从 Messages tab 发送消息。把各 Agent App 分别邀请到需要参与的频道；私有频道必须由有权限的人邀请。OAuth scopes 变更后，对每个 App **重新安装到 workspace**；更新 bindings 与 token 环境引用，保留每个 App 对应关系。多个 App 的同名 `/team` 是同一 owner 控制入口，Slack 实际路由到哪个安装实例由 Slack 决定；任一实例都必须维持 owner 检查。

将凭证按配置所引用的环境变量写入 `/etc/mate/mate.env`，保留 `root:mate 0640`；不要放入源码、manifest 或命令行参数，不把文件内容贴进测试记录。没有凭证时仅进行 manifest/config/doctor/status/logs 等离线检查；完成真实授权和 provider transport/accounting 检查前不能宣称 Slack/provider 集成已验证。

## 只读检查与启动

```sh
sudo matectl status
sudo matectl logs
sudo matectl doctor
```

`status` 固定查看 `mate.service` 的 systemd ActiveState，组合平台中立 OperationsView 的 Agent/active-run/paused/unknown action/unknown output/held draft/due reminder 计数、root upgrade journal、deployment journal 和 restore journal。它不构造 Daemon，不加载 secret 环境文件，不执行迁移或恢复。升级/restore 未完成为 `recovery-pending`；journal 无法解析为 `recovery-unreadable`；停止、未知服务状态、无法读取数据库都不会显示健康。`running` 只说明本地进程与读取状态正常，不证明 Slack/provider 连通。计数截断会明确标示；status 和系统状态是相邻时刻快照，并非跨系统原子事务。

`logs` 固定为 `mate.service` 的平台中立持久运行事实：过去 **24 小时，最多 100 条** run completed/failed/interrupted 或 internal DM created 事件，只输出时间和固定事件名。它**不读取或回显原始 journald**，因为异常栈、第三方 SDK 日志可能包含秘密；不输出 Agent/消息/工具标识、正文、工具参数/结果、文件内容或环境值。`available=false` 表示查询不可用，`moreAvailable` 表示历史还有记录，不保证这些记录仍在 24 小时窗口内。这不是完整审计日志，历史事实覆盖以 OperationsView 的持久记录为限。两个命令都不接受额外 flags、unit、时间、路径、environment 或任意 journalctl 参数。

首次安装完成并配置好 secrets 后：

```sh
sudo matectl offline-probe
sudo systemctl enable --now mate.service
sudo matectl status
```

offline probe 必须在服务停止时运行；它验证本地隔离和工作区，不启动 Slack/provider。

## candidate、恢复、激活与 finalize

先构建完整新 release，再把它和新配置固定到 root 控制的 staging。确保没有未完成升级；`/opt/mate/staged-release` 必须不存在，不覆盖活跃 attempt 的输入。

```sh
sudo cp -a /var/tmp/mate-release /opt/mate/staged-release
sudo chown -R root:root /opt/mate/staged-release
sudo chmod -R go-w /opt/mate/staged-release
sudo install -o root -g root -m 0600 /ABSOLUTE/new-mate.json /etc/mate/staged-config.json
sudo matectl candidate
sudo matectl status
```

candidate 先绑定 staged release/config，停止服务，封存 rollback checkpoint，再通过 journal 迁移 DB、原子发布 config/current 并做离线 doctor/probe。整个 candidate 阶段不启动 daemon、Slack/provider、ACK/run/outbox。中断后保持相同 staged 输入，执行 `sudo matectl resume`；不要手工删除 journal 或改 current symlink。`/opt/mate/controller` 保留已知可用控制器，避免坏 candidate 阻断维护入口。

尚未激活时，可执行 `sudo matectl rollback`：验证封存的旧 checkpoint 和新当前 checkpoint，再恢复旧数据、配置和 current。服务保持停止；检查后由操作员重新启动。不能只退代码而保留新 DB/config。

确认 candidate 后：

```sh
sudo matectl activate
sudo matectl status
sudo matectl logs
sudo matectl finalize
```

activate 在允许启动之前持久化 `everActivated`。一旦激活，即使启动失败，也只能 fix-forward：准备新的完整 staged release/config，执行 `sudo matectl fix-forward`，离线成功后再次 activate，再 finalize。已提交的 B→C attempt 必须先完成到 C；尚未提交的 attempt 只有在 controller 验证 DB 无提交 marker、持久 config 仍为 B 时才允许替换为 B→D。不要凭人的猜测覆盖已绑定 staged 输入；命令会依据持久证据决定是否接受替换。

finalize 验证当前发布，将 controller 发布到已验证 release，保留 current、controller、previous 指向的 release，并清理本次升级的临时 checkpoint、旧的未保留 release 与升级 journal。常规命名备份和运行数据不会被清理。清理先在 root journal 中持久记录目标目录身份，中断后仅继续删除身份匹配的目录；身份不符时停下由操作员调查。后续需要改变 topology 时须先制定独立迁移方案，不能靠修改 systemd/config 绕过核验。

## 备份、恢复与停用

先 `sudo systemctl stop mate.service`，再执行 `sudo matectl backup NAME`。固定 `/var/backups/mate` 下的 NAME 仅允许简单名称，长度不超过 64；checkpoint 由服务用户生成、root 封存。普通恢复使用 `sudo matectl restore OLD_NAME --replace CURRENT_NAME`，CURRENT_NAME 必须是当前状态对应的已封存 checkpoint；空环境恢复可省略 replace。restore 中断后使用同一 checkpoint 参数重入，status 会显示 pending。存在 deployment upgrade journal 时普通 restore/backup 等严格入口仍被阻断，使用 upgrade 命令恢复。恢复完成后检查，再启动服务。

停用沿用 `deploy disable /etc/mate/mate.json`，保留 state/backings/checkpoints/releases；不要 rm 数据来“解除”恢复锁。原始系统日志若需管理员进一步调查，必须在受信终端单独处理，不作为 matectl 的可转发输出。
