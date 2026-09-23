# Debian 13 部署

首版部署使用普通 Linux 用户隔离 Agent，不需要 Docker 镜像或 workspace mount。这里是待人执行的步骤；本地合成测试不等于已接通 Slack/provider，也不等于已在目标 VPS 安装。运维命令见 [运维手册](OPERATIONS_RUNBOOK.md)。

## 准备系统和 Agent 身份

目标为 Debian 13 x86_64、systemd、`/usr/bin/node` 24.x、pnpm 10.33.0。必须有 `/usr/bin/systemd-run`、`/usr/bin/systemctl`、`/usr/bin/setpriv`、`/usr/bin/getent`。为每位 Agent 预建独立的普通账户；示例 UID/GID 只是示意，真实值必须与配置和 `getent passwd` 一致：

```sh
sudo groupadd -g 2001 mate-research
sudo useradd -u 2001 -g 2001 -M -d /srv/mate/private/research -s /bin/bash mate-research
sudo groupadd -g 2002 mate-writer
sudo useradd -u 2002 -g 2002 -M -d /srv/mate/private/writer -s /bin/bash mate-writer
sudo install -d -o root -g root -m 0755 /srv/mate /srv/mate/private
```

若账户已存在，先核对 UID、GID、home 和附加组，不要重复创建或改号。Agent 不应属于 root、docker 或其他附加组。私人 home、`notes`、`artifacts`、`MEMORY.md`、共享目录和配额 slice 由 installer 建立；`/srv/mate/private` 等父目录须先存在且为 root 所有。私人 home 是 `Agent UID:GID 0700`，Mate 状态 `/var/lib/mate` 为 `root:root 0700`，共享根 `/srv/mate/shared` 为 `root:root 0755`，其下每位 Agent 的工作目录是 `Agent UID:GID 0755`。

## 构建发布物与配置

在 Debian 13 目标机用同一 Node 24 ABI 构建，避免从另一种系统复制原生依赖：

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm typecheck
install -d -m 0755 /var/tmp/mate-release
cp package.json pnpm-lock.yaml /var/tmp/mate-release/
cp -a dist /var/tmp/mate-release/
(cd /var/tmp/mate-release && pnpm install --prod --frozen-lockfile --package-import-method=copy)
```

复制 [mate.example.json](../mate.example.json) 与 [mate.deploy.example.json](../mate.deploy.example.json) 到 root 可读的绝对路径。填入真实 Agent UID/GID、Slack app/bot/owner 身份和模型。`release.source` 指向完整发布目录，`release.gitCommit` 填构建源码 commit，`configSource` 指向配置文件。`environmentSource` 可指向已准备的凭证环境文件；若缺省，installer 创建空文件，服务不会自动启动。Linux 用户模式不使用 `privateWorkspaces`、`externalWorkspaces`、`workspaceManifest` 或 `docker` 字段。

## 计划、预检与安装

```sh
pnpm --silent run deploy plan /ABSOLUTE/mate.deploy.json
sudo /usr/bin/node /ABSOLUTE/checkout/dist/src/deployment/cli.js preflight /ABSOLUTE/mate.deploy.json
sudo /usr/bin/node /ABSOLUTE/checkout/dist/src/deployment/cli.js install /ABSOLUTE/mate.deploy.json
```

`plan` 展示预配置账户、私人/共享/控制目录权限、每位 Agent 的 systemd slice 配额、发布与状态空间预算。`preflight` 在写入前核对 Debian/Node、系统工具、passwd 身份和附加组、磁盘/内存、服务停止状态。`install` 复制并验证发布物、建立目录和 systemd 单元，创建 `/usr/local/sbin/matectl`，保留 `mate.service` 停止状态。重跑同一安装输入可检查已有对象；不同内容不会静默覆盖。

安装后把实际凭证写入 `/etc/mate/mate.env`，保持 `root:root 0600`。在目标机运行：

```sh
sudo matectl doctor
sudo matectl offline-probe
sudo systemctl enable --now mate.service
sudo matectl status
```

`doctor` 核对发布物、配置/凭证、UID/GID、私人/共享目录、root 控制面、有限的 slice 配额与审批配置；不会连接 Slack/provider。`offline-probe` 只检查本地身份和配额，要求主服务与 Agent 后台任务先停止。真实 Slack/provider 接线、usage 和错误协议仍需单独验收。

原生 Debian 13 smoke 仅需两个 UID：互相读不到私人 `MEMORY.md`，能读同伴共享工作文件、仅可写自己的共享目录；均不能读 Mate state/config 或控制 systemd 的 Mate 服务；启动一个 Agent 长任务后能以其身份列出并停止。此检查不能由 macOS 合成测试替代。
