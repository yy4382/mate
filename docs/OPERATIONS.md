# Debian 13 部署与运维

首版在低资源 x86_64 Debian 13 VPS 上运行。每位 Agent 使用独立的非特权 Linux 用户账号执行普通文件操作和命令；Mate 的数据库和凭证只允许 root 读取。系统级命令由用户通过 Slack 卡片逐条批准。安装不会自行连接 Slack 或启动主服务。配置字段见[配置说明](CONFIGURATION.md)。

## 准备和安装

系统需要 systemd、`/usr/bin/node` 24.x、pnpm 10.33.0，以及 `/usr/bin/systemd-run`、`/usr/bin/systemctl`、`/usr/bin/setpriv`、`/usr/bin/getent`。通过正常软件包渠道安装，不手工拼接 Node 或原生依赖。为每位 Agent 预建单独的普通账户，并核对 UID、GID、home 和附加组；不能把它们加入 root 或特权组。示例 `research` 和 `writer` 对应的 UID/GID 写入 [mate.example.json](../mate.example.json)，部署参数写入 [mate.deploy.example.json](../mate.deploy.example.json)。私人目录父路径须由 root 预建；安装器建立私人 home、起始文件、共享子目录和资源限额。

先在开发 checkout 对拟发布提交运行 `pnpm check` 和 `pnpm typecheck`。在目标系统使用与服务相同的 Node ABI 构建完整发布物，并运行 Linux 定向验证：

```sh
MATE_COMMIT=$(git rev-parse HEAD)
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
MATE_NATIVE_UID_TEST=1 pnpm exec vitest run tests/execution/linux-user-tools.test.ts
install -d -m 0755 /var/tmp/mate-release
cp package.json pnpm-lock.yaml /var/tmp/mate-release/
cp -a dist /var/tmp/mate-release/
(cd /var/tmp/mate-release && pnpm install --prod --frozen-lockfile --package-import-method=copy)
pnpm --silent run deploy release-manifest /var/tmp/mate-release "$MATE_COMMIT" > /var/tmp/mate-RELEASE.json
mv /var/tmp/mate-RELEASE.json /var/tmp/mate-release/RELEASE.json
```

发布物必须对应干净的源码提交，不能只复制少数验证器文件。复制示例配置与部署参数至 root 可读的绝对路径，填入真实账户、Slack 身份和发布物路径。然后执行：

```sh
pnpm --silent run deploy plan /ABSOLUTE/mate.deploy.json
sudo /usr/bin/node /ABSOLUTE/checkout/dist/src/deployment/cli.js preflight /ABSOLUTE/mate.deploy.json
sudo /usr/bin/node /ABSOLUTE/checkout/dist/src/deployment/cli.js install /ABSOLUTE/mate.deploy.json
```

`plan` 展示账号、目录、资源与磁盘计划；`preflight` 检查系统、账号及附加组、资源和现有服务；`install` 验证并复制完整发布物，配置 systemd 与 `matectl`，但保持服务停止。同一输入可重跑检查；不会静默覆盖不同身份的安装。将密钥放入 `/etc/mate/mate.env`，保持 `root:root 0600`，不放进 JSON、manifest、源码或命令行。

## Slack App 接线

每位 Agent 使用独立的 Slack App 和 bot。用生成器为每位成员生成 manifest，导入 Slack 并安装到同一个 workspace：

```sh
pnpm --silent run deploy slack-manifest research > /var/tmp/mate-research-slack.json
pnpm --silent run deploy slack-manifest writer > /var/tmp/mate-writer-slack.json
```

完整权限清单以生成文件为准；它也是事件和 `/team` 命令的单一来源。为每个 App 创建仅授予 `connections:write` 的 Socket Mode app token，安装后取得 bot token；在配置的 binding 中分别填入真实 team/app/user/bot ID 和凭证环境变量名。启用 App Home Messages tab，邀请 bot 到需参与的频道；私有频道由有权限的人邀请。权限变化后重装对应 App。Socket Mode 不需要公开 HTTP 接收地址。内部会话需要展示到 Slack 时，按[投影指南](PROJECTIONS.md)单独配置。

真实接线要核对 App 身份、频道顶层与 thread/DM、内部 Agent DM、附件和成果、草稿补读后的所有合法选择、owner 与非 owner 控制、系统命令批准/拒绝/过期、429 与 unknown 对账，以及 provider usage、错误、取消和超时。脚本化模型验证 harness 能否支持这些选择；真实连接验证传输、授权和记账协议。连接前不能把合成测试称作真实 Slack/provider 验收。

## 检查、启动和日常操作

```sh
sudo matectl doctor
sudo matectl offline-probe
sudo systemctl enable --now mate.service
sudo matectl status
sudo matectl logs
```

`doctor` 只读检查发布物、配置、Agent 账号、私人/共享目录、Mate 控制数据、资源限额和审批配置；`offline-probe` 要求主服务和 Agent 后台任务已停止，验证本地账号、限额，以及每位 Agent 的私人 home、MEMORY.md 与共享目录归属。服务使用 systemd `Type=notify`，在自己的恢复和调度启动完成后就报告 ready，不等待 Slack 连接和历史追赶（Slack 凭证在每次连接尝试时检查，结果作为该安装的就绪状态单独报告）：Slack 不可达时进程继续运行，内部会话、提醒和普通执行照常进行，daemon 运行与各 Slack 安装是否就绪分别记录在结构化运行事实中，需要 Slack 的操作等对应安装就绪后才执行，暂时故障自动重试，凭据或权限问题给出需要人工处理的动作。`status` 与 `logs` 只读固定的服务状态及结构化运行事实，不输出原始 journald 或秘密；本地 running 状态不证明 Slack/provider 连通。

在 Debian 13 上另用两个真实 Agent 账号做原生检查：分别读自己的与同伴的 `MEMORY.md`，读同伴共享文件、只写自己的共享目录，尝试读取 Mate 数据库/凭证和控制服务；再启动、列出、停止一个长任务。使用合成文件记录 UID、命令和退出码，不读取真实私人记忆。macOS 模拟测试不能代替这些检查。

## 备份、升级与停用

先停止 `mate.service` 和 Agent 后台任务；维护命令会复查。`sudo matectl backup NAME` 保存 SQLite 与每位 Agent 的私人 home，最后发布完成标记。共享目录另按普通 VPS 文件备份方式处理，并保留 UID/GID。`sudo matectl restore OLD --replace CURRENT` 要求 CURRENT 是当前状态的匹配 checkpoint；中断后用相同参数恢复，不删库或清理恢复标记来绕过检查。

代码升级先构建完整新发布物、停机并备份，再运行 `sudo matectl upgrade /ABSOLUTE/new-mate.deploy.json`。它替换已验证 release 并要求配置与已安装配置一致。首版只有一套数据库格式，没有版本化迁移：同格式内的程序升级与重启保留会话、投递、任务、提醒和身份，但把数据目录退回旧版程序不受支持，需要时从升级前检查点恢复（`sudo matectl restore`）。验证后用 `sudo matectl finalize` 确认。配置变更先按上面的步骤取一份 checkpoint，再停机替换 `/etc/mate/mate.json` 并启动一次 Mate 让它应用并记录；现有 Agent 身份、UID/GID/home 和共享根不得改变，`runtime.dataDir` 不变才延续原有数据。原生操作细节与命令契约以安装器、`matectl` 和相关测试为准。

配置只写 `mate.runTimeoutMs`；`mate.budgets` 等旧额度字段不再被接受，配置校验会直接拒绝整个文件。模型用量按每次 provider 调用持久记录为已知或未知，没有运行次数、token 或费用额度。

停用使用 `sudo /usr/bin/node /opt/mate/current/dist/src/deployment/cli.js disable /etc/mate/mate.json`。它停止主服务，保留后台任务、文件、数据库、checkpoint 和发布物；需要结束后台任务时明确列出并逐项停止。
