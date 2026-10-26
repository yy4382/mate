# Mate 部署指南

> 读者：部署 Linux 控制面，以及在 Linux、macOS 或 Windows 上安装 node 的管理员。
> 配套文档：[ARCHITECTURE.md](ARCHITECTURE.md) 第 6、7 节。

## 1. 部署形态

```
VPS（Ubuntu 24.04 / Debian 13，x86_64 或 arm64）
│
├─ 控制面：一个 Docker 容器，以一个专用的无登录系统账号（例如 mate-control）的 UID/GID 运行
│    网页、聊天 app、管理模块、Agent Manager、所有 Agent 的 runtime、node 网关
│    数据：宿主上一个只属于这个系统账号的私有 bind 目录 → 容器内 data/
│
├─ node 账号：一个普通账号（例如 mate），不在 docker 组里
│   └─ node：systemd 用户服务（mate-node.service），由 `mate node` CLI 管理
│        在 Agent 的工作区里执行命令、读写文件；主动用 WebSocket 连控制面
│
└─ 你自己已有的 HTTPS 反向代理（Caddy、nginx 等）→ 控制面端口
```

**为什么分两个账号。** Agent 的命令以 node 账号运行。控制面的数据目录里有模型 API key、密码哈希和所有对话；它如果也属于 node 账号，任何 Agent 都能 `cat` 出来。所以数据目录属于另一个账号，node 账号连进入它的权限都没有。同理，node 账号不能在 docker 组里：能用 Docker 就等于宿主上的 root。控制面由 root（或你别的管理账号）用 `docker compose` 管理。

- **规模假设**：几个人、少量 Agent（ARCHITECTURE §10）。一台低配置 VPS 足够；资源主要花在模型 API 费用上，不在本机。
- **Mate 不做的事**：不创建系统用户，不切换身份，不安装系统软件，不改 sudo、Docker 权限或 linger，不装证书或反向代理。Agent 在命令里自己写的 `sudo` 能不能成功，由宿主的 sudo 配置决定。
- **控制面和 node 可以不在同一台机器上。** node 主动连控制面，只需要能访问控制面的地址。控制面部分按 Linux 同机部署来写；§3.2 覆盖三个平台的 node。

## 2. 前提

1. 一台 Ubuntu 24.04 或 Debian 13 的 VPS，x86_64 或 arm64。
2. 一个给 node 用的普通账号（不是 root，不在 docker 组里），例如 `sudo useradd -m -s /bin/bash mate`。node 会以它运行，Agent 的命令也以它运行，所以给它的权限就是你愿意给 Agent 的权限。
3. 一个给控制面用的无登录系统账号，例如 `sudo useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin mate-control`。它只是数据目录的所有者，容器以它的 UID/GID 运行。
4. 一个能用 Docker Engine 和 Docker Compose 的管理账号（root 或你自己的账号）。
5. node 账号有可用的 systemd user manager。如果希望注销后、或开机后 node 也一直运行，需要你自己执行 `sudo loginctl enable-linger <账号>`，Mate 不替你做。
6. 一个域名和 HTTPS 反向代理。浏览器推送（Web Push）和登录 cookie 都需要 HTTPS。
7. 至少一个模型提供商的 API key。管理界面提供 OpenAI（Responses API）和 DeepSeek 两家（ARCHITECTURE 4.6）。

## 3. 安装

### 3.1 控制面

控制面是 `deploy/control-plane/` 里的一个镜像加两个 Compose 文件：`compose.yaml` 是日常配置，`compose.initialize.yaml` 只在第一次启动时叠加，把第一个管理员的初始密码文件和 handle 交给控制面。镜像用 `docker build --file deploy/control-plane/Dockerfile .` 从仓库根目录构建，构建出的镜像带网页前端；发布时由 CI 推到镜像仓库，用确切的版本号，不用 `latest`。

镜像保留编译后的 workspace 包，由 `pnpm deploy --prod` 装入独立的生产依赖，不把服务端和第三方包合成一个 JavaScript 文件。依赖在目标架构上安装，保留原生模块和包内资源。每个 PR 和 main 都复用发布构建任务，构建 x64、arm64 Linux 镜像和 node 发布包，跳过发布步骤。只有 Markdown、MDX、reST、AsciiDoc、`docs/` 下的文件或根目录 LICENSE/NOTICE 变动时，跳过这个构建任务，其余检查照常；`v*` 标签始终构建并发布。node 发布包里的 JavaScript 由 tsdown 打包。

1. 建一个只属于控制面系统账号的私有数据目录，权限 0700，放在 node 账号进不去的地方，例如 `sudo install -d -m 700 -o mate-control -g mate-control /srv/mate-control-plane/data`。Compose 不会替你建它（目录不存在就拒绝启动），因为让 Docker 建出来的会属于 root。
2. 镜像在 GHCR 上公开，可以匿名拉取，不需要登录。
3. 把 `compose.yaml`、`compose.initialize.yaml` 和 `.env.example`（改名 `.env`）放在同一个目录，填好 `.env`（变量见下表）。`MATE_UID`、`MATE_GID` 用 `id -u mate-control`、`id -g mate-control` 查。这个目录和 `.env` 只给管理账号看（例如放在 root 的 `/srv/mate-control-plane`，权限 0700；容器的绑定挂载不受上级目录权限影响）。
4. 写初始密码文件（至少 12 字节，末尾的换行不算），属于控制面系统账号、权限 0600（容器以它的身份读这个文件），路径写进 `.env` 的 `MATE_INITIAL_PASSWORD`；第一个管理员的 handle 写进 `MATE_INITIAL_HANDLE`（缺省 `admin`，字母、数字、`_`、`.`、`-`，不分大小写）。控制面只在库里还没有任何人类时读它们：用这个 handle 建第一个人类账号（显示名同 handle）并设为管理员，密码只存 scrypt 哈希（ARCHITECTURE §4.7、MODULE_TESTS 11.1）；第一次启动没有密码文件，或 handle 不合法，就拒绝启动。之后其他人由管理员添加（`POST /api/humans`），每个人用自己的 handle 和密码登录，角色是管理员或普通人类，普通人类只能聊天。
5. 第一次启动叠加两个文件：

   ```sh
   docker compose -f compose.yaml -f compose.initialize.yaml up -d --wait
   ```

   用初始 handle 和初始密码登录网页，确认能登录后，删掉初始密码文件，之后只用 `compose.yaml`：`docker compose up -d`。
6. 让 HTTPS 反向代理把你的域名转发到控制面端口（宿主 `127.0.0.1:8787`），**并把浏览器请求里原来的 `Host` 传过去**。控制面拒绝 `Origin` 和 `Host` 不一致的写请求（跨站防护，ARCHITECTURE §4.7），而 nginx 的 `proxy_pass` 缺省把 `Host` 换成上游地址，结果连登录都回 403 `cross-origin`；nginx 里要写 `proxy_set_header Host $host;`（Caddy 缺省就保留原 `Host`）。登录 cookie 带 `Secure`，浏览器只在 HTTPS（或 `localhost`）上保存它，所以经 HTTP 访问 VPS 的 IP 登录不上；Web Push 也需要 HTTPS。反向代理不要缓冲 `text/event-stream` 响应：nginx 认控制面发的 `X-Accel-Buffering: no`，其他代理要自己关缓冲；控制面每 25 秒发一次心跳，读超时设得比这长。

`.env` 里的变量（`compose.yaml` 读它们）：

| 变量 | 含义 | 缺省 |
|---|---|---|
| `MATE_IMAGE` | 控制面镜像，写确切版本号 | 必填 |
| `MATE_UID`、`MATE_GID` | 容器进程的 UID 和 GID，用数据目录的所有者（控制面系统账号） | 必填 |
| `MATE_DATA` | 宿主上的数据目录，绑定挂载到容器内 `/var/lib/mate` | 必填，目录必须已存在 |
| `MATE_INITIAL_PASSWORD` | 初始密码文件的宿主路径，只有 `compose.initialize.yaml` 读它 | 第一次启动必填 |
| `MATE_INITIAL_HANDLE` | 第一个管理员的 handle，只有 `compose.initialize.yaml` 读它 | `admin` |
| `MATE_LISTEN` | 宿主上监听的地址和端口 | `127.0.0.1:8787` |
| `MATE_VAPID_SUBJECT` | 见下表 | `mailto:owner@mate.invalid` |

控制面进程读这些环境变量（ARCHITECTURE §4.7）。Compose 已经替你设好，只有 `MATE_VAPID_SUBJECT` 和（第一次启动时的）`MATE_INITIAL_HANDLE` 通过 `.env` 改：

| 变量 | 含义 | 缺省 |
|---|---|---|
| `MATE_DATA_DIRECTORY` | 数据目录（§5.1）；Compose 设成 `/var/lib/mate` | 必填 |
| `MATE_PORT`、`MATE_HOST` | 监听的端口和地址；容器里是 `8787`、`0.0.0.0`，由 Compose 只映射到 `MATE_LISTEN` | `8787`、`127.0.0.1` |
| `MATE_INITIAL_PASSWORD_FILE` | 初始密码文件，只在第一次启动（还没有任何人类）时读；`compose.initialize.yaml` 设成 `/run/secrets/initial_password` | 无 |
| `MATE_INITIAL_HANDLE` | 第一个管理员的 handle，同样只在第一次启动时用；`compose.initialize.yaml` 从 `.env` 的 `MATE_INITIAL_HANDLE` 设入 | `admin` |
| `MATE_WEB_DIRECTORY` | 构建好的网页前端目录；镜像里是 `/opt/mate/web`；没有时 API 照常，页面回 404 | 无 |
| `MATE_VAPID_SUBJECT` | 推送服务联系你用的 `mailto:` 或 `https:` 地址，写在每个推送请求的签名里 | `mailto:owner@mate.invalid` |

镜像以非 root 用户运行，`user:` 让 Compose 换成控制面系统账号的 UID/GID，所以数据目录里的文件属于它，node 账号读不到。镜像自带健康检查（带不带会话都能答的 API 路径返回 401 就算健康）。`SIGTERM`（`docker compose stop`）让控制面先断开所有连接，再依次关闭所有 Agent、网关和聊天库后退出，在 Compose 的 10 秒期限内完成。

### 3.2 node

node 支持 Linux、macOS 和 Windows，各有 x64、arm64 发布包。安装、更新、卸载都由 `mate node` 完成，没有单独的安装脚本，也没有下载步骤。管理员把同一版本的 `mate-node-<版本>-<平台>-<架构>.tar.gz` 与旁边的 `.sha256` 下载到 node 机器上；平台名是 `linux`、`darwin`、`win`。包自带 Node 24，宿主不需要安装 Node、pnpm 或编译器。

**第一次安装。** 先校验再解包，运行包内的 CLI。以下版本号只是示例，用实际下载的文件名替换。

Linux：

```sh
sha256sum -c mate-node-0.1.0-linux-x64.tar.gz.sha256
tar -xzf mate-node-0.1.0-linux-x64.tar.gz
./mate-node/bin/mate node install mate-node-0.1.0-linux-x64.tar.gz
rm -r mate-node
```

macOS，在当前账号的图形登录会话内操作：

```sh
shasum -a 256 -c mate-node-0.1.0-darwin-arm64.tar.gz.sha256
tar -xzf mate-node-0.1.0-darwin-arm64.tar.gz
./mate-node/bin/mate node install mate-node-0.1.0-darwin-arm64.tar.gz
rm -r mate-node
```

Windows，在当前账号的 PowerShell 中操作，不需要管理员权限：

```powershell
$bundle = 'mate-node-0.1.0-win-x64.tar.gz'
$expected = (Get-Content "$bundle.sha256").Split(' ')[0]
if ((Get-FileHash $bundle -Algorithm SHA256).Hash -ne $expected) { throw 'Checksum mismatch' }
tar -xzf $bundle
.\mate-node\bin\mate.cmd node install $bundle
Remove-Item -Recurse .\mate-node
```

`install` 自己也校验整个包，再在暂存目录解包检查：只能有普通文件和目录，路径在 `mate-node/` 内，文件与清单 `manifest.json` 一一对应，平台和架构与本机相同。任何一项不通过，已有安装不变。

安装放好程序、命令和服务定义，**不启动服务**。POSIX 的命令是 `~/.local/bin/mate` 符号链接；Windows 是 `%LOCALAPPDATA%\Mate\bin\mate.cmd` 普通文件，不需要符号链接特权。CLI 不改用户的持久 PATH；把对应 bin 目录加入自己的 PATH，或使用安装输出中的完整命令路径。

Windows 的已安装命令在更新或卸载时，先把管理入口和运行时复制到 TEMP 下的临时目录，从那里执行，每次留下的运行时副本约 80 MB，管理命令结束后可删除 `%TEMP%\mate-node-cli-*` 目录。这样管理进程不会锁住待替换的 `node.exe`。服务仍直接使用程序目录中的运行时。

**配置和启动。** 在网页的“节点管理”里生成一次性配对令牌，然后运行：

```sh
mate node configure --control-plane https://mate.example.com --pairing-token <令牌>
mate node start
```

同机 Linux 部署可以用 `http://127.0.0.1:8787`，其他机器使用能访问到的控制面地址。`--workspaces <目录>` 可指定工作区根，缺省为账号的 `mate/workspaces`。网页显示 node 在线后，可以不带 `--pairing-token` 再运行一次 `configure` 去掉令牌；留下也无妨，node 每次先用自己的身份签名认证。

**布局和文件保护。** 程序、配置、身份与工作区分开：

| 内容 | Linux | macOS | Windows |
|---|---|---|---|
| 程序目录 | `~/.local/lib/mate-node` | 同 Linux | `%LOCALAPPDATA%\Mate\program` |
| 命令 | `~/.local/bin/mate` | 同 Linux | `%LOCALAPPDATA%\Mate\bin\mate.cmd` |
| 服务定义 | `~/.config/systemd/user/mate-node.service` | `~/Library/LaunchAgents/io.mate.node.plist` | `%LOCALAPPDATA%\Mate\config\node-task.xml`，注册为 `Mate node <账号 SID>` |
| 配置 | `~/.config/mate/node.json` | 同 Linux | `%LOCALAPPDATA%\Mate\config\node.json` |
| 身份和链路 | `~/.local/share/mate/node` | 同 Linux | `%LOCALAPPDATA%\Mate\data` |
| 日志 | 用户 journal | 身份目录内的 `node.log` | 身份目录内的 `node.log` |
| 缺省工作区 | `~/mate/workspaces` | 同 Linux | `%USERPROFILE%\mate\workspaces` |

程序目录包含清单、运行时、许可证、`lib/mate.mjs` 和启动命令。暂存目录在程序目录旁，名字为 `.mate-node-staging-*`、`.mate-node-old-*`。POSIX 的私有目录和文件使用 0700、0600。Windows 依赖当前账号 LOCALAPPDATA 的默认 ACL 隔离其他普通账号；Mate 不用 `chmod` 冒充 ACL 设置，这也不是对管理员或 SYSTEM 的隔离。

`install`、`update`、`uninstall` 只管理程序、命令和服务定义。配置、身份、日志和工作区保留。

**每个命令从现有状态决定动作**（ARCHITECTURE §11 第 1 条），不记录“做到哪一步”。这张表在三个平台都成立：

| 命令 | 看到的状态 | 做什么 |
|---|---|---|
| `install <包>` | 程序目录不存在 | 校验并解包到暂存目录，再改名成程序目录 |
| | 已装同一版本 | 保留程序，补齐缺失的 Mate 命令和服务定义 |
| | 已装另一版本 | 拒绝，提示用 `update` |
| | 程序目录没有可读清单 | 拒绝，不改动它 |
| | 命令或服务定义属于别人 | 保留并报告，不能覆盖或操作那个服务 |
| | 服务正在运行或已被管理员停用 | 不启动、不重启、不重新启用 |
| `update <包>` | 服务运行、过渡中、可能重启或状态不明 | 拒绝；先用 `mate node stop` 停妥 |
| | 程序目录含清单外文件 | 拒绝并列出文件 |
| | 已完全停止且版本不同 | 校验新包，旧目录挪开，新目录改名就位，再删旧目录 |
| | 程序目录不存在 | 按首次安装放好，服务仍保持停止 |
| `uninstall` | 程序目录不是 Mate 的或含清单外文件 | 拒绝，不改文件和服务 |
| | 服务定义属于 Mate，或能确认是 Mate 已加载的服务 | 停用并停止，删除 Mate 的服务定义 |
| | 服务定义属于别人 | 不停它、不删它，输出中报告 |
| | 命令属于 Mate | 删掉；别人的命令保留 |
| | 程序目录存在 | 挪进暂存目录后删除 |
| `start` | 没装、没有服务定义、配置缺失或服务属于别人 | 拒绝 |
| | 其余 | 启用并启动，重复调用收敛到正在运行 |
| `stop` | 服务未安装 | 报告无须停止 |
| | Mate 的服务已存在 | 停用并停止，之后保持停止 |
| `status` | 任何状态 | 报告程序、命令、服务、链路和配置，不打印配对令牌 |
| 修改命令 | 发现上次留下的暂存目录 | 清理本程序的暂存内容 |

服务管理器按下面的现有事实执行这些动作：

| 动作或状态 | Linux / systemd | macOS / launchd | Windows / Task Scheduler |
|---|---|---|---|
| 安装 | 写用户单元，变更时 daemon-reload；不 enable/start | 写 Disabled 的 LaunchAgent；不 bootstrap | 注册当前账号 InteractiveToken 的登录任务，缺省禁用；不 Run |
| 启动 | `systemctl --user enable --now` | `launchctl enable`，未加载时 `bootstrap gui/<uid>`，已加载但停止时 kickstart | schtasks 启用任务并 Run |
| 停止 | `systemctl --user disable --now` | disable 后 bootout，避免下次登录重启 | 先禁用任务，终止已确认身份的 node 进程树，再 End |
| 允许更新 | inactive 或 failed | 已停止且不会等待自动重启 | 禁用且没有运行实例 |
| 拒绝更新 | active、activating、deactivating、reloading、未知 | running、等待重启、状态无法确认 | enabled、queued、running、状态无法确认 |
| 卸载 | 停止、删除 Mate 单元、daemon-reload | 停止、删除 Mate plist | 停止、Delete Mate 任务、删除 Mate XML |
| 状态查询 | show 的服务属性 | print 的有限状态和 PID；解析不明按 unknown | COM 的数字状态和实例，CIM 的进程身份，不解析本地化状态文字 |
| 没有可用管理器 | 写文件前失败，提示当前账号需要 user manager | 写文件前失败，提示需要当前账号的 GUI domain | 写文件前失败，保留已有文件 |

中途失败就重跑同一个命令。程序目录要么是完整旧版本、完整新版本，要么不存在。清单外的文件不会被更新或卸载悄悄删除。

**链路。** `node run` 在数据目录的 `link.json` 原子记录 `{ pid, connected, since }`。`mate node status` 只有在服务正在运行，并能核对它的执行进程时才显示 `Link: connected/disconnected since <时间>`；否则显示 `Link: none`。Linux 核对 MainPID，macOS 核对 launchctl PID，Windows 核对任务实例与 CIM 进程路径和创建时间，不能把 Task Scheduler 的 EnginePID 直接当作 node PID。服务运行本身不表示已连接控制面。

**退出与重启。** 没有配置或身份被拒绝时，前台 `node run` 以 78 退出。Linux 用 RestartPreventExitStatus 阻止重启；macOS 的服务入口 `node run --service` 把这个不可重试退出映射为 0，原因仍记入日志。Linux/macOS 的其他失败由服务管理器重启。Windows 计划任务不保证在进程异常退出后重启：原生 CI 中以 1 退出后，`RestartOnFailure` 也未触发重启。因此 Windows node 崩溃后需执行 `mate node start`，或在下次登录时启动。此时任务仍启用，`status` 可能显示 `Service: ready, enabled`，不能据此判断进程是否崩溃；`Link: none` 表示没有已确认的链路。计划任务只在当前账号登录时运行，不保存账号密码，不切换到 LocalSystem。

POSIX 管理命令拒绝 root。Mate 不创建账号、不配置 linger、不修改 Windows ACL，也不授予提权能力。

### 3.3 第一个 Agent

1. 网页"管理"里填入模型提供商的 API key。
2. 创建 Agent：填显示名、handle、模型。Manager 会依次开聊天账号、让 node 建工作区、建 Agent 文件（ARCHITECTURE §4.4）。
3. 在频道里 @ 它。它会收到一条通知，自己决定读取并回复。

## 4. 日常运维

| 要做的事 | 怎么做 |
|---|---|
| 看 node 状态、日志 | `mate node status`（版本、服务状态、链路、配置，不打印令牌）、`mate node logs [--lines <n>] [--follow]` |
| 启停 node | `mate node stop`（停止并停用）、`mate node start`（启用并启动）。stop 之后保持停止，重复 `install` 也不会启动它 |
| 看控制面日志、启停 | 在放 `compose.yaml` 的目录里 `docker compose logs -f`、`docker compose stop`、`docker compose start`。日常命令只用 `compose.yaml`，不叠加 `compose.initialize.yaml` |
| 暂停或恢复某个 Agent | 网页"管理"。暂停 = 立刻关闭它的 runtime，进行中的模型请求和 node 上的命令都被停掉（网关逐个通知 node 停掉仍能追踪的命令进程组；POSIX 脱组进程和 Windows 已失去父链的孤儿不在保证内，见 ARCHITECTURE 4.5）；恢复后从停下的地方接着跑 |
| 看 Agent 在想什么、做了什么 | 网页"管理"里的实时对话记录 |
| 看用量 | 网页"管理"。只用于观察，没有任何配额 |

控制面崩溃和网络断线会自动恢复：控制面重启后，Manager 打开所有没暂停的 Agent，从各自存下的位置继续；node 断线时进行中的命令以"结果未知"交给 Agent，node 自己按退避重连（ARCHITECTURE §5.5、§5.6）。

## 5. 数据、备份、更新、卸载

### 5.1 数据在哪

```
<数据目录>/                     控制面容器里的 data/
  control.sqlite               每个人类的角色和密码哈希、登录会话、VAPID 密钥、API key、node 注册表；控制面以 0600 新建它
  chat.sqlite                  聊天的全部数据
  attachments/                 附件文件（还没有实现）
  agents/<agentId>.sqlite      每个 Agent 的全部状态：对话、配置、提醒、连接器位置、是否暂停
```

node 一侧：node 的身份密钥和配置在 node 账号自己的目录里；每个 Agent 的工作区也在 node 上，不挂载进控制面容器。

一个 Agent 存在，当且仅当它的 `agents/<agentId>.sqlite` 存在。没有别的 Agent 列表需要维护。

### 5.2 备份与搬家

1. 停控制面：`docker compose stop`。
2. 复制整个数据目录（连同 `-wal`、`-shm` 文件），保留所有者，例如 `sudo cp -a /srv/mate-control-plane/data /srv/mate-control-plane/backup-$(date +%F)`。
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

**命令环境升级。** 先升级控制面，再升级 Linux/macOS node。新控制面拒绝把 Bash 交给未在当前认证连接声明 `shellContext` 的旧 POSIX 或未知平台 node，并提示升级；文件工具仍可用，当前连接明确报告 Windows 时仍使用原有 PowerShell 路径。POSIX node 的宿主账号默认 shell 必须是 Bash 或 zsh。HOME 改为 node 用户主目录，首次命令在工作区，之后主对话前台命令记住 cwd；文件工具仍以工作区为根。启动配置只在每个 Agent 首次调用时读取，修改配置或修复初始化失败后重启 node 生效；重启同时清空所有 Agent 的目录记忆，下次调用明确提示新环境初始化。连接重连和控制面重启不会清空它。本次变化不迁移存储。

**数据原地迁移**（ARCHITECTURE §6、§11 第 8 条）。新版本启动时把数据库升到自己的结构版本，迁移在一个事务里，失败就回滚、拒绝启动并报出文件名，数据库留在旧版本。数据库比程序新、或停在新版本不认识的版本时同样拒绝启动，不改动它。升级到会迁移数据的版本之前，先备份数据目录：迁移成功后旧版本拒绝启动（数据库比程序新），所以回退就是换回旧镜像并恢复这份备份，没有别的办法；备份之后写入的数据随之丢失。

1. `docker compose down`，复制一份数据目录作备份（回退要用它）。
2. `.env` 里改 `MATE_IMAGE`，其余不动。
3. 只用 `compose.yaml` 起新版本：`docker compose up -d --wait`（初始化用的 `compose.initialize.yaml` 不再叠加，库里已有人类）。需要回退时，`docker compose down`，把 `MATE_IMAGE` 换回旧镜像，用第 1 步的备份替换数据目录，再起旧版本；不要让旧版本直接打开已迁移的数据目录。

**从只有一个所有者的版本（v0.1.0-alpha.2 及以前）升级。** 原来的所有者在升级后成为管理员：handle 是 `owner`，显示名 `Owner`，密码不变，已登录的浏览器继续有效，这个账号的会话、未读和推送订阅都在。所以升级不需要初始密码文件，`MATE_INITIAL_HANDLE` 也不起作用（库里已经有人类）；用 handle `owner` 登录，之后可以自己改显示名和 handle，也可以添加别的人类。

### 5.4 卸载

`mate node uninstall` 停止并停用服务，删除程序目录、Mate 命令和服务定义，保留配置、身份和工作区（MODULE_TESTS §9）；中断后重新执行即可完成。它只删 Mate 的东西：程序目录里有清单外的文件时拒绝并列出它们，不是 Mate 写的单元文件或 `mate` 命令留着不动并报告。控制面用 `docker compose down` 删除容器，数据目录保留。

不是 Mate 写的单元文件，`uninstall` 不删，也不停用它定义的服务。

### 5.5 自动部署

控制面和 node 在同一台 Linux 机器上时，可以让 CI 在每次发版后自动升级：推送 `v*` 标签（标签要打在 main 上的提交上；它不重跑检查，而是等这个提交在 main 上的 `checks` 通过，没通过就不发版；重跑 main 上失败的任务后再重跑发版任务），镜像和发布包发布之后，`.github/workflows/ci.yml` 的 Deploy 任务用一把专用 SSH key 连到这台机器，执行 `deploy/auto-update/mate-deploy`，把 5.3 的步骤做一遍。没有预发环境，所以每次部署都先备份数据目录，失败就自动回退。

`mate-deploy` 以 root 运行，从 SSH 拿到 `deploy <版本> <sha256>`，从标准输入拿到这台机器架构的 node 发布包：

1. 校验发布包，拉取 `MATE_IMAGE_REPO:<版本>` 镜像。已经是这个版本时什么都不做。
2. 停 node，`docker compose down`，把数据目录复制到 `<控制面目录>/backups/before-<版本>-<时间>`。
3. 改 `.env` 的 `MATE_IMAGE`，`docker compose up -d --wait`，确认 `/api/me` 回 401、`/login` 回 200。
4. `mate node update` 新发布包，`mate node start`，然后每秒看一次 `mate node status`，`MATE_NODE_CONNECT_WAIT` 秒（默认 60）内出现 `Link: connected` 才算起好，期间一旦出现就继续；超时则打印 node 日志并回退。随后控制面仍然健康。控制面有 `MATE_HEALTH_WAIT` 秒（默认 30）变健康。
5. 保留最近 `MATE_KEEP_BACKUPS` 份备份，以及新旧两个版本的发布包（在 `/var/lib/mate-deploy/bundles/`）。每次部署的输出也追加到 `/var/lib/mate-deploy/deploy.log`；CI 中途断开时部署照常做完或回退，结果看这里。

第 2 步之后任何一步失败，都回到原来的镜像，用刚才的备份替换数据目录，把 node 换回原来的发布包并启动（原来的版本可能还没有 `Link:` 行，所以这里只等控制面健康，不等链路），然后以失败退出，CI 里这次部署显示为失败。回退要用正在运行的那个版本的发布包，所以第一次启用前要把它放进 `/var/lib/mate-deploy/bundles/`（连同 `.sha256`），没有它时 `mate-deploy` 不动手。同一时间只有一次部署在跑。

**设置**（在这台机器上，以 root）：

```sh
install -m 0755 deploy/auto-update/mate-deploy /usr/local/sbin/mate-deploy
install -m 0600 deploy/auto-update/mate-deploy.env.example /etc/mate-deploy.env   # 按实际路径改
install -d -m 0700 /var/lib/mate-deploy/bundles
cp mate-node-<当前版本>-linux-x64.tar.gz* /var/lib/mate-deploy/bundles/
ssh-keygen -t ed25519 -N '' -C mate-deploy -f mate-deploy-key   # 私钥交给 GitHub 后删掉
echo "restrict,command=\"/usr/local/sbin/mate-deploy\" $(cat mate-deploy-key.pub)" >> /root/.ssh/authorized_keys
```

`restrict,command=` 让这把 key 只能执行 `mate-deploy`，没有 shell、转发和终端；拿到它的人最多能把这台机器升级到一个已发布的版本。GitHub 仓库里建一个 `production` 环境，放三个 secret：`DEPLOY_HOST`（例如 `root@203.0.113.7`）、`DEPLOY_SSH_KEY`（私钥）和 `DEPLOY_KNOWN_HOSTS`（`ssh-keyscan` 得到、和你已知的主机指纹核对过的那一行）。主机地址、key 和主机指纹只放在这里，不写进仓库，Action 日志里也被遮掉。不是 x86_64 时再设仓库变量 `DEPLOY_NODE_ARCH=arm64`。没有 `DEPLOY_HOST` 时 Deploy 任务什么都不做。

## 6. 在开发机上运行

需要 Node 24、pnpm 10；跑 Linux 测试还需要 Docker（macOS 上用 OrbStack 即可）。node 的执行与 CLI 测试在 Linux、macOS、Windows 上运行，CI 的 macOS/Windows 任务另外构建本机发布包并验证真实服务。真实服务冒烟只在一次性 CI 账号上显式启用，日常 `pnpm check` 不安装开发机的服务。

```sh
pnpm install
pnpm check          # 格式、类型检查、全部测试（只跳过明确限定其他平台的测试）
pnpm test:linux     # 在非 root 的 Linux 容器里跑 node 的测试套件（以子进程启动 node，真实的进程组与文件系统）
```

开发机可用 `pnpm bundle:node <版本>` 构建全部六个包；`--platform linux|darwin|win32` 与 `--arch x64|arm64` 可缩小目标，产物在 `dist/node-bundles/`。自动部署继续只使用 Linux 包，macOS/Windows node 手动安装和更新。

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
curl -i -X POST localhost:8787/api/login -H 'content-type: application/json' -d '{"handle":"admin","password":"一个至少十二字节的密码"}'
```

登录返回的 `Set-Cookie` 要原样带在之后的请求里。路由见 ARCHITECTURE §4.7。各模块的边界测试是验证系统的主要手段，`apps/control-plane/test/composition.test.ts` 以真实 HTTP 跑通"经 HTTP 配对 node、创建 Agent、管理员私信它、它回复并推送"。

