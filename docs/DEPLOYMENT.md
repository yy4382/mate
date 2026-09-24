# Debian 13 部署

首版为每位 Agent 使用独立的普通 Linux 用户账号。这里是待人执行的步骤；在本地模拟 Slack 或模型服务的测试，不能证明真实账号已连接，也不能证明 Mate 已安装到目标 VPS。运维命令见 [运维手册](OPERATIONS_RUNBOOK.md)。

## 准备系统和 Agent 身份

目标为 Debian 13 x86_64、systemd、`/usr/bin/node` 24.x、pnpm 10.33.0。必须有 `/usr/bin/systemd-run`、`/usr/bin/systemctl`、`/usr/bin/setpriv`、`/usr/bin/getent`。为每位 Agent 预建独立的普通账户；下方用户编号（UID）和组编号（GID）只是示意，真实值必须与配置和 `getent passwd` 一致：

```sh
sudo groupadd -g 2001 mate-research
sudo useradd -u 2001 -g 2001 -M -d /srv/mate/private/research -s /bin/bash mate-research
sudo groupadd -g 2002 mate-writer
sudo useradd -u 2002 -g 2002 -M -d /srv/mate/private/writer -s /bin/bash mate-writer
sudo install -d -o root -g root -m 0755 /srv/mate /srv/mate/private
```

若账户已存在，先核对 UID、GID、私人目录和附加组，不要重复创建或改号。Agent 不应属于 root、docker 或其他附加组。安装程序建立私人目录、`notes`、`artifacts`、`MEMORY.md`、共享目录和每位 Agent 的系统资源限额；`/srv/mate/private` 等父目录须先存在且为 root 所有。私人目录由对应 Agent 持有，权限为 `0700`；Mate 状态目录 `/var/lib/mate` 为 `root:root 0700`；共享根 `/srv/mate/shared` 为 `root:root 0755`，其下每位 Agent 的工作目录由该 Agent 持有，权限为 `0755`。

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

复制 [mate.example.json](../mate.example.json) 与 [mate.deploy.example.json](../mate.deploy.example.json) 到 root 可读的绝对路径。填入真实 Agent UID/GID、Slack app/bot/owner 身份和模型。`release.source` 指向完整发布目录，`release.gitCommit` 填构建源码 commit，`configSource` 指向配置文件。`environmentSource` 可指向已准备的凭证环境文件；若缺省，安装程序创建空文件，服务不会自动启动。

## 计划、预检与安装

```sh
pnpm --silent run deploy plan /ABSOLUTE/mate.deploy.json
sudo /usr/bin/node /ABSOLUTE/checkout/dist/src/deployment/cli.js preflight /ABSOLUTE/mate.deploy.json
sudo /usr/bin/node /ABSOLUTE/checkout/dist/src/deployment/cli.js install /ABSOLUTE/mate.deploy.json
```

`plan` 展示将创建的账号、目录权限、每位 Agent 的系统资源限额，以及所需磁盘空间。`preflight` 在写入前核对 Debian/Node、系统工具、账号及附加组、磁盘/内存、服务停止状态。`install` 复制并验证发布物、建立目录和 systemd 服务配置，创建 `/usr/local/sbin/matectl`，保留 `mate.service` 停止状态。重跑同一安装输入可检查已有对象；不同内容不会静默覆盖。

安装后把实际凭证写入 `/etc/mate/mate.env`，保持 `root:root 0600`。在目标机运行：

```sh
sudo matectl doctor
sudo matectl offline-probe
sudo systemctl enable --now mate.service
sudo matectl status
```

`doctor` 核对发布物、配置/凭证、Agent 账号、私人/共享目录、Mate 管理文件及接口的权限、系统资源限额与审批配置；不会连接 Slack 或模型服务。`offline-probe` 只检查本地账号和资源限额，要求主服务与 Agent 后台任务先停止。真实 Slack 和模型服务的连接、用量记录与错误处理仍需单独验收。

在 Debian 13 上做小型实际检查：用两个不同的 Agent 账号确认互相读不到私人 `MEMORY.md`，能读同伴共享工作文件、仅能写自己的共享目录；两个账号都不能读 Mate 的数据库、配置或控制 Mate 服务；启动一个 Agent 长任务后能查看并停止它。macOS 上模拟账号的测试不能代替这项检查。
