# Mate 部署指南（重写版）

> 读者：要把 Mate 装到一台 Linux VPS 上的所有者。
> 配套文档：[ARCHITECTURE.md](ARCHITECTURE.md) 第 6、7 节，[PLAN.md](PLAN.md)。

## 0. 现在能不能部署

**能，做第一次部署。** M1–M8 已完成并经过独立审查：聊天 app、Agent runtime（含历史工具和上下文压缩）、Agent Manager、node 网关与 node、登录与 HTTP 路由、实时事件流、Web Push、管理模块、网页前端、控制面镜像、node 发布包和 `mate node` CLI。`pnpm smoke:deploy` 在 Docker 里用发布的镜像和 node 发布包跑通登录、配对、创建 Agent、私信回复和重启后数据仍在（MODULE_TESTS §13）。

还没做或没验证过的：

| 事项 | 现状 |
|---|---|
| 起真实进程的端到端场景（M9） | 未开始；各模块的边界测试和部署冒烟是目前的验证手段 |
| 发布工作流（`.github/workflows/release.yml`） | 写好了，还没在真实的 `v*` 标签上跑过；第一次发布后在一台干净的主机上拉一次镜像确认 |
| 部署冒烟覆盖的架构 | arm64 原生跑过；x86_64 镜像和发布包在 arm64 主机上经仿真跑过（`MATE_SMOKE_ARCH=x64 pnpm smoke:deploy`），还没在真实的 x86_64 主机上跑过 |
| 反向代理和 HTTPS | 冒烟不经过反向代理；按 §3.1 第 6 步配置 |
| 附件 | 第一版之后（ARCHITECTURE §11 第 7 条） |

## 1. 部署形态

```
VPS（Ubuntu 24.04 / Debian 13，x86_64 或 arm64）
│
├─ 现有普通账号（例如 chris，UID 1000）
│   ├─ 控制面：一个 Docker 容器，以这个账号的 UID/GID 运行
│   │    网页、聊天 app、管理模块、Agent Manager、所有 Agent 的 runtime、node 网关
│   │    数据：宿主上一个私有 bind 目录 → 容器内 data/
│   │
│   └─ node：systemd 用户服务（mate-node.service），由 `mate node` CLI 管理
│        在 Agent 的工作区里执行命令、读写文件；主动用 WebSocket 连控制面
│
└─ 你自己已有的 HTTPS 反向代理（Caddy、nginx 等）→ 控制面端口
```

- **规模假设**：一个所有者、少量 Agent（ARCHITECTURE §10）。一台低配置 VPS 足够；资源主要花在模型 API 费用上，不在本机。
- **Mate 不做的事**：不创建系统用户，不切换身份，不安装系统软件，不改 sudo、Docker 权限或 linger，不装证书或反向代理。Agent 在命令里自己写的 `sudo` 能不能成功，由宿主的 sudo 配置决定。
- **控制面和 node 可以不在同一台机器上。** node 主动连控制面，只需要能访问控制面的地址。首版按同机部署来写。

## 2. 前提

1. 一台 Ubuntu 24.04 或 Debian 13 的 VPS，x86_64 或 arm64。
2. 一个现有的普通账号（不是 root）。node 会以它运行，Agent 的命令也以它运行，所以给它的权限就是你愿意给 Agent 的权限。
3. 这个账号能用 Docker Engine 和 Docker Compose。
4. 这个账号有可用的 systemd user manager。如果希望注销后、或开机后 node 也一直运行，需要你自己执行 `sudo loginctl enable-linger <账号>`，Mate 不替你做。
5. 一个域名和 HTTPS 反向代理。浏览器推送（Web Push）和登录 cookie 都需要 HTTPS。
6. 至少一个模型提供商的 API key。具体接哪家还没定，测试目前按 OpenAI Responses 协议模拟模型。

## 3. 安装

### 3.1 控制面

控制面是 `deploy/control-plane/` 里的一个镜像加两个 Compose 文件：`compose.yaml` 是日常配置，`compose.initialize.yaml` 只在第一次启动时叠加，把初始密码文件交给控制面。镜像用 `docker build --file deploy/control-plane/Dockerfile .` 从仓库根目录构建，构建出的镜像带网页前端；发布时由 CI 推到镜像仓库，用确切的版本号，不用 `latest`。

1. 建一个只属于你账号的私有数据目录，权限 0700，例如 `mkdir -m 700 -p ~/mate/data`。Compose 不会替你建它（目录不存在就拒绝启动），因为让 Docker 建出来的会属于 root。
2. 仓库是私有的，镜像仓库里的镜像也是私有的。先在 VPS 上登录 GHCR：用一个只有 `read:packages` 权限的 GitHub token，`echo <token> | docker login ghcr.io -u <GitHub 用户名> --password-stdin`。
3. 把 `compose.yaml`、`compose.initialize.yaml` 和 `.env.example`（改名 `.env`）放在同一个目录，填好 `.env`（变量见下表）。`MATE_UID`、`MATE_GID` 用 `id -u`、`id -g` 查你的账号。
4. 写初始密码文件（至少 12 字节，末尾的换行不算），权限 0600，路径写进 `.env` 的 `MATE_INITIAL_PASSWORD`。控制面只在库里还没有密码时读它，只存 scrypt 哈希（ARCHITECTURE §4.7、MODULE_TESTS 11.1）；第一次启动没有它就拒绝启动。
5. 第一次启动叠加两个文件：

   ```sh
   docker compose -f compose.yaml -f compose.initialize.yaml up -d --wait
   ```

   用初始密码登录网页，确认能登录后，删掉初始密码文件，之后只用 `compose.yaml`：`docker compose up -d`。
6. 让 HTTPS 反向代理把你的域名转发到控制面端口（宿主 `127.0.0.1:8787`），**并把浏览器请求里原来的 `Host` 传过去**。控制面拒绝 `Origin` 和 `Host` 不一致的写请求（跨站防护，ARCHITECTURE §4.7），而 nginx 的 `proxy_pass` 缺省把 `Host` 换成上游地址，结果连登录都回 403 `cross-origin`；nginx 里要写 `proxy_set_header Host $host;`（Caddy 缺省就保留原 `Host`）。登录 cookie 带 `Secure`，浏览器只在 HTTPS（或 `localhost`）上保存它，所以经 HTTP 访问 VPS 的 IP 登录不上；Web Push 也需要 HTTPS。反向代理不要缓冲 `text/event-stream` 响应：nginx 认控制面发的 `X-Accel-Buffering: no`，其他代理要自己关缓冲；控制面每 25 秒发一次心跳，读超时设得比这长。

`.env` 里的变量（`compose.yaml` 读它们）：

| 变量 | 含义 | 缺省 |
|---|---|---|
| `MATE_IMAGE` | 控制面镜像，写确切版本号 | 必填 |
| `MATE_UID`、`MATE_GID` | 容器进程的 UID 和 GID，用数据目录的所有者 | 必填 |
| `MATE_DATA` | 宿主上的数据目录，绑定挂载到容器内 `/var/lib/mate` | 必填，目录必须已存在 |
| `MATE_INITIAL_PASSWORD` | 初始密码文件的宿主路径，只有 `compose.initialize.yaml` 读它 | 第一次启动必填 |
| `MATE_LISTEN` | 宿主上监听的地址和端口 | `127.0.0.1:8787` |
| `MATE_VAPID_SUBJECT` | 见下表 | `mailto:owner@mate.invalid` |

控制面进程读这些环境变量（ARCHITECTURE §4.7）。Compose 已经替你设好，只有 `MATE_VAPID_SUBJECT` 通过 `.env` 改：

| 变量 | 含义 | 缺省 |
|---|---|---|
| `MATE_DATA_DIRECTORY` | 数据目录（§5.1）；Compose 设成 `/var/lib/mate` | 必填 |
| `MATE_PORT`、`MATE_HOST` | 监听的端口和地址；容器里是 `8787`、`0.0.0.0`，由 Compose 只映射到 `MATE_LISTEN` | `8787`、`127.0.0.1` |
| `MATE_INITIAL_PASSWORD_FILE` | 初始密码文件，只在第一次启动时读；`compose.initialize.yaml` 设成 `/run/secrets/initial_password` | 无 |
| `MATE_WEB_DIRECTORY` | 构建好的网页前端目录；镜像里是 `/opt/mate/web`；没有时 API 照常，页面回 404 | 无 |
| `MATE_VAPID_SUBJECT` | 推送服务联系你用的 `mailto:` 或 `https:` 地址，写在每个推送请求的签名里 | `mailto:owner@mate.invalid` |

镜像以非 root 用户运行，`user:` 让 Compose 换成你的 UID/GID，所以数据目录里的文件属于你的账号。镜像自带健康检查（带不带会话都能答的 API 路径返回 401 就算健康）。`SIGTERM`（`docker compose stop`）让控制面先断开所有连接，再依次关闭所有 Agent、网关和聊天库后退出，在 Compose 的 10 秒期限内完成。

### 3.2 node

node 的安装、更新、卸载都由 `mate node` 完成，没有单独的安装脚本，也没有下载步骤：发布包是两个文件，你用 `scp` 或 `gh release download` 自己拿到机器上。CLI 不碰下载凭据，下载出错也由你熟悉的工具报告。

1. 把同一版本号、对应架构的两个文件放到 node 机器上：`mate-node-<版本>-linux-<x64|arm64>.tar.gz` 和它旁边的 `.sha256`。发布包自带 Node 24 运行时，宿主不需要装 Node、pnpm 或编译器。开发机上用 `pnpm bundle:node <版本>` 构建，产物在 `dist/node-bundles/`。
2. 用包里的 CLI 安装（第一次只能这样，之后用装好的 `mate`）：

   ```sh
   sha256sum -c mate-node-0.1.0-linux-x64.tar.gz.sha256
   tar -xzf mate-node-0.1.0-linux-x64.tar.gz
   ./mate-node/bin/mate node install mate-node-0.1.0-linux-x64.tar.gz
   rm -r mate-node
   ```

   第一次没有 `mate` 可用，所以由你先跑 `sha256sum -c`，再解包。`install` 自己也会按 `.sha256` 校验整个包，再在暂存目录里解包并检查：只能有普通文件和目录，路径都在 `mate-node/` 下，文件和清单 `manifest.json` 一一对应，平台和架构与本机相同。任何一项不过就拒绝，已安装的东西不变。通过后它放好程序目录、`~/.local/bin/mate` 链接和用户服务单元，**不启动服务**。
3. 在网页的"节点管理"里生成一次性配对令牌，写进配置：

   ```sh
   mate node configure --control-plane http://127.0.0.1:8787 --pairing-token <令牌> [--workspaces <目录>]
   ```

   它整份重写 `~/.config/mate/node.json`（权限 0600）。同机部署时控制面地址用 `http://127.0.0.1:8787`，不是容器服务名。工作区根目录默认 `~/mate/workspaces`。
4. `mate node start`：启用并启动 `mate-node.service`。
5. 网页显示 node 在线后，可以不带 `--pairing-token` 再跑一次 `configure`，把令牌从配置里去掉。不去也没关系：node 先用自己的身份签名认证，令牌已经用掉。

**磁盘上的东西。** 全在这个账号的 HOME 下：

```
~/.local/lib/mate-node/                  程序目录：发布包的内容，整个替换，从不原地修改
  manifest.json                          版本、平台、架构和程序目录里每个文件的清单
  bin/mate  node/bin/node  node/LICENSE  lib/mate.mjs
~/.local/lib/.mate-node-staging-*/       Mate 的暂存目录；命令开始时发现的都是上次中断留下的，直接删掉
~/.local/lib/.mate-node-old-*/
~/.local/bin/mate                        指向 ~/.local/lib/mate-node/bin/mate 的符号链接
~/.config/systemd/user/mate-node.service 单元文件，第一行注明由 mate node 写；本地修改放进 drop-in
~/.config/mate/node.json                 配置（configure 写）
~/.local/share/mate/node/                node 的身份密钥（node 第一次运行时生成）
~/mate/workspaces/<agentId>/             Agent 的工作区（位置由配置决定）
```

`install`、`update`、`uninstall` 只动前四项。配置、身份和工作区它们从不碰。

**每个命令从现有状态推出该做什么**（ARCHITECTURE §11 第 1 条），不记"做到哪一步"：

| 命令 | 看到的状态 | 做什么 |
|---|---|---|
| `install <包>` | 程序目录不存在 | 校验、解包到暂存目录、改名成程序目录 |
| | 已装同一版本 | 程序目录不动 |
| | 已装另一版本 | 拒绝，提示用 `update`，什么都不改 |
| | 程序目录没有清单（不是 Mate 的） | 拒绝，什么都不改 |
| | 之后：`mate` 链接、单元文件不存在或是 Mate 的旧内容 | 补上或重写（单元变了才 `daemon-reload`）；是别人的就不碰，在输出里报告 |
| | 服务 | 从不启用、启动、重启 |
| `update <包>` | 服务不是 `inactive`/`failed` | 拒绝，什么都不改 |
| | 程序目录里有清单外的文件 | 拒绝并列出它们，什么都不改 |
| | 已装另一版本 | 校验、解包到暂存目录，旧程序目录改名挪开，暂存目录改名成程序目录，删掉旧的 |
| | 程序目录不存在（上次死在两次改名之间） | 和首次安装一样放好 |
| | 之后 | 同 `install` 的链接和单元；服务保持停止 |
| `uninstall` | 程序目录有清单外的文件或不是 Mate 的 | 拒绝，什么都不改 |
| | 单元文件是别人的 | 不碰它，也不停用它定义的服务（只读状态），在输出里报告 |
| | 单元文件是 Mate 的，或服务已加载但没有单元文件 | `systemctl --user disable --now`，再删单元文件并 `daemon-reload` |
| | `mate` 链接是 Mate 的 | 删掉；别人的不碰并报告 |
| | 程序目录存在 | 挪进暂存目录再删 |
| `start` | 没装、没有单元或没有配置 | 拒绝 |
| | 其余 | `systemctl --user enable --now` |
| `stop` | 服务单元已加载 | `systemctl --user disable --now`；之后保持停止，开机也不启动 |
| 所有修改命令 | 开头发现的暂存目录 | 删掉 |

中途失败就重跑同一个命令。程序目录要么是旧版本、要么是新版本、要么不存在，不会是半个。最坏的情况，删掉 `~/.local/lib/mate-node` 再 `install`，Agent 的资料都在程序目录之外。

管理命令以 root 运行时拒绝。服务以 `mate node run` 运行；没有配置或身份被网关拒绝时它以 78 退出，单元的 `RestartPreventExitStatus=78` 让 systemd 不再重启它，`mate node status` 和 `mate node logs` 能看到原因。

### 3.3 第一个 Agent

1. 网页"管理"里填入模型提供商的 API key。
2. 创建 Agent：填显示名、handle、模型。Manager 会依次开聊天账号、让 node 建工作区、建 Agent 文件（ARCHITECTURE §4.4）。
3. 在频道里 @ 它。它会收到一条通知，自己决定读取并回复。

## 4. 日常运维

| 要做的事 | 怎么做 |
|---|---|
| 看 node 状态、日志 | `mate node status`（版本、服务状态、配置，不打印令牌）、`mate node logs [--lines <n>] [--follow]` |
| 启停 node | `mate node stop`（停止并停用）、`mate node start`（启用并启动）。stop 之后保持停止，重复 `install` 也不会启动它 |
| 看控制面日志、启停 | 在放 `compose.yaml` 的目录里 `docker compose logs -f`、`docker compose stop`、`docker compose start`。日常命令只用 `compose.yaml`，不叠加 `compose.initialize.yaml` |
| 暂停或恢复某个 Agent | 网页"管理"。暂停 = 立刻关闭它的 runtime，进行中的模型请求和 node 上的命令都被停掉（网关逐个通知 node 杀掉这些命令的进程组；用 `setsid` 之类脱离进程组的后台进程不受影响）；恢复后从停下的地方接着跑 |
| 看 Agent 在想什么、做了什么 | 网页"管理"里的实时对话记录 |
| 看用量 | 网页"管理"。只用于观察，没有任何配额 |

崩溃和断线不需要人工处理：控制面重启后，Manager 打开所有没暂停的 Agent，从各自存下的位置继续；node 断线时进行中的命令以"结果未知"交给 Agent，node 自己按退避重连（ARCHITECTURE §5.5、§5.6）。

## 5. 数据、备份、更新、卸载

### 5.1 数据在哪

```
<数据目录>/                     控制面容器里的 data/
  control.sqlite               密码哈希、登录会话、VAPID 密钥、API key、node 注册表；控制面以 0600 新建它
  chat.sqlite                  聊天的全部数据
  attachments/                 附件文件
  agents/<agentId>.sqlite      每个 Agent 的全部状态：对话、配置、提醒、连接器位置、是否暂停
```

node 一侧：node 的身份密钥和配置在 node 账号自己的目录里；每个 Agent 的工作区也在 node 上，不挂载进控制面容器。

一个 Agent 存在，当且仅当它的 `agents/<agentId>.sqlite` 存在。没有别的 Agent 列表需要维护。

### 5.2 备份与搬家

1. 停控制面：`docker compose stop`。
2. 复制整个数据目录（连同 `-wal`、`-shm` 文件），例如 `cp -a ~/mate/data ~/mate/backup-$(date +%F)`。
3. 在新机器上用同一版本启动，`.env` 的 `MATE_DATA` 指向复制过去的目录。数据库里已有密码，所以不需要 `compose.initialize.yaml`。

node 的工作区按普通文件备份即可。node 换机器时，在新机器上重新配对。

### 5.3 更新

先停 node，再停控制面，两边换成**同一版本**，先启动控制面并确认能登录，再启动 node。node 一侧：

```sh
mate node stop
mate node update mate-node-0.2.0-linux-x64.tar.gz   # 服务没完全停止时拒绝，什么都不改
mate node start
```

`update` 之后服务保持停止。程序目录里如果有你自己放的文件，`update` 会拒绝并列出它们，挪走后重跑。

**数据不做迁移**（ADR-0002）。新版本发现某个数据库的结构版本不对时，会拒绝启动并报出文件名，不会改动它。重写期间结构变化很频繁（例如聊天库已经从版本 1 变成版本 2），所以在正式发布之前，每次升级都可能需要换一个新的空数据目录（ARCHITECTURE §11 第 8 条，所有者已接受）：

1. `docker compose down`，旧数据目录原样留着，需要回退时还能用。
2. 建一个新的空 0700 目录，`.env` 里改 `MATE_IMAGE` 和 `MATE_DATA`，把初始密码文件重新写出来。
3. 用两个 Compose 文件起新版本（§3.1 第 4 步），重新配对 node、重建 Agent；Agent 的工作区在 node 上，不受影响。旧数据目录里的对话不会带过来。

### 5.4 卸载

`mate node uninstall` 停止并停用服务，删除程序目录、`~/.local/bin/mate` 和单元文件，保留配置、身份和工作区（MODULE_TESTS §9）；中断后重新执行即可完成。它只删 Mate 的东西：程序目录里有清单外的文件时拒绝并列出它们，不是 Mate 写的单元文件或 `mate` 命令留着不动并报告。控制面用 `docker compose down` 删除容器，数据目录保留。

不是 Mate 写的单元文件，`uninstall` 不删，也不停用它定义的服务。

## 6. 今天在开发机上能做什么

需要 Node 24、pnpm 10；跑 Linux 测试还需要 Docker（macOS 上用 OrbStack 即可）。

```sh
pnpm install
pnpm check          # 格式、类型检查、全部测试（macOS 上会跳过只能在 Linux 上跑的测试）
pnpm test:linux     # 在非 root 的 Linux 容器里跑 node 的测试套件（以子进程启动 node，真实的进程组与文件系统）
```

控制面可以在本机启动，前端要先构建，再用 `MATE_WEB_DIRECTORY` 指给它：

```sh
pnpm --filter "@mate/control-plane..." build
pnpm --filter @mate/web build     # 产物在 apps/web/dist
mkdir -m 700 -p ~/mate-dev && printf '%s\n' '一个至少十二字节的密码' > ~/mate-dev/password
MATE_DATA_DIRECTORY=~/mate-dev/data MATE_INITIAL_PASSWORD_FILE=~/mate-dev/password \
  MATE_WEB_DIRECTORY=apps/web/dist node apps/control-plane/dist/src/main.js
# 浏览器打开 http://localhost:8787 。登录 cookie 带 Secure，只有 localhost 和 HTTPS 上浏览器才保留它，所以不要用局域网 IP。
# 改前端时可以另开 `pnpm --filter @mate/web dev`（Vite 开发服务器，/api 代理到 8787）。
# 也可以直接用 HTTP 客户端：
curl -i -X POST localhost:8787/api/login -H 'content-type: application/json' -d '{"password":"一个至少十二字节的密码"}'
```

登录返回的 `Set-Cookie` 要原样带在之后的请求里。路由见 ARCHITECTURE §4.7。各模块的边界测试仍是验证系统的主要手段，`apps/control-plane/test/composition.test.ts` 以真实 HTTP 跑通"经 HTTP 配对 node、创建 Agent、所有者私信它、它回复并推送"。

## 7. 正式部署之前还要定的事

见 PLAN.md 的 M5–M9。node 安装器不用可续做的状态机，已经决定（架构文档第 11 节第 1 条，本文 §3.2）。
