# Mate 部署指南

> 读者：部署 Linux 控制面，以及在 Linux、macOS 或 Windows 上安装 node 的管理员。
> 配套文档：[ARCHITECTURE.md](ARCHITECTURE.md) 第 6、7 节。

## 1. 部署形态

```
VPS（Ubuntu 24.04 / Debian 13，x86_64）
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

1. 一台 Ubuntu 24.04 或 Debian 13 的 VPS，x86_64。
2. 一个给 node 用的普通账号（不是 root，不在 docker 组里），例如 `sudo useradd -m -s /bin/bash mate`。node 会以它运行，Agent 的命令也以它运行，所以给它的权限就是你愿意给 Agent 的权限。
3. 一个给控制面用的无登录系统账号，例如 `sudo useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin mate-control`。它只是数据目录的所有者，容器以它的 UID/GID 运行。
4. 一个能用 Docker Engine 和 Docker Compose 的管理账号（root 或你自己的账号）。
5. node 账号有可用的 systemd user manager。如果希望注销后、或开机后 node 也一直运行，需要你自己执行 `sudo loginctl enable-linger <账号>`，Mate 不替你做。
6. 一个域名和 HTTPS 反向代理。浏览器推送（Web Push）和登录 cookie 都需要 HTTPS。
7. 至少一个模型提供商的 API key。管理界面提供 OpenAI（Responses API）和 DeepSeek 两家（ARCHITECTURE 4.6）。

## 3. 安装

### 3.1 控制面

控制面是 `deploy/control-plane/` 里的一个镜像加两个 Compose 文件：`compose.yaml` 是日常配置，`compose.initialize.yaml` 只在第一次启动时叠加，把第一个管理员的初始密码文件和 handle 交给控制面。镜像用 `docker build --file deploy/control-plane/Dockerfile .` 从仓库根目录构建，构建出的镜像带网页前端；发布时由 CI 推到镜像仓库，用确切的版本号，不用 `latest`。

镜像保留编译后的 workspace 包，由 `pnpm deploy --prod` 装入独立的生产依赖，不把服务端和第三方包合成一个 JavaScript 文件。依赖在目标架构上安装，保留原生模块和包内资源。每个 PR 和 main 都复用发布构建任务，构建 x64 Linux 镜像和 node 发布包，跳过发布步骤；下载的 Node 运行时按 `deploy/node/node-runtimes.ts` 缓存。只有 Markdown、MDX、reST、AsciiDoc、`docs/` 下的文件或根目录 LICENSE/NOTICE 变动时，跳过这个构建任务，其余检查照常；`v*` 标签始终构建并发布。node 发布包里的 JavaScript 由 tsdown 打包。

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

node 支持 x86_64 的 Linux、Apple 芯片的 macOS 和 x64 的 Windows，各有一个发布包。安装、更新、卸载都由 `mate node` 完成，没有单独的安装脚本，也没有下载步骤。管理员把同一版本的 `mate-node-<版本>-<平台>-<架构>.tar.gz` 与旁边的 `.sha256` 下载到 node 机器上；平台名是 `linux`、`darwin`、`win`。包自带 Node 24，宿主不需要安装 Node、pnpm 或编译器。

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

**Linux/macOS 的命令 shell。** node 账号的默认 shell 必须是 Bash 或 zsh。命令使用账号的主目录作 HOME，并带上它的交互启动配置；node 进程只读一次启动文件，修改后（或启动配置出错后）重启 node 生效。控制面先升级时，旧 node 仍按原方式（`/bin/sh`、工作区作 HOME）执行，直到它也升级。

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

`restrict,command=` 让这把 key 只能执行 `mate-deploy`，没有 shell、转发和终端；拿到它的人最多能把这台机器升级到一个已发布的版本。GitHub 仓库里建一个 `production` 环境，放三个 secret：`DEPLOY_HOST`（例如 `root@203.0.113.7`）、`DEPLOY_SSH_KEY`（私钥）和 `DEPLOY_KNOWN_HOSTS`（`ssh-keyscan` 得到、和你已知的主机指纹核对过的那一行）。主机地址、key 和主机指纹只放在这里，不写进仓库，Action 日志里也被遮掉。没有 `DEPLOY_HOST` 时 Deploy 任务什么都不做。

## 6. 在开发机上运行

需要 Node 24、pnpm 10；跑 Linux 测试还需要 Docker（macOS 上用 OrbStack 即可）。node 的执行与 CLI 测试在 Linux、macOS、Windows 上运行，CI 的 macOS/Windows 任务另外构建本机发布包并验证真实服务。真实服务冒烟只在一次性 CI 账号上显式启用，日常 `pnpm check` 不安装开发机的服务。

```sh
pnpm install
pnpm check          # 格式、类型检查、全部测试（只跳过明确限定其他平台的测试）
pnpm test:linux     # 在非 root 的 Linux 容器里跑 node 的测试套件（以子进程启动 node，真实的进程组与文件系统）
```

开发机可用 `pnpm bundle:node <版本>` 构建全部三个包；`--platform linux|darwin|win32` 可缩小目标，产物在 `dist/node-bundles/`。自动部署继续只使用 Linux 包，macOS/Windows node 手动安装和更新。

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

### 6.1 原生移动客户端

`apps/mobile` 是自用的 iOS 27+ Expo app，在 app 内保存一个 HTTPS 服务器地址，用已有 handle 和密码登录，进入聊天、管理、个人资料与通知设置。所有依赖从仓库根安装，只有一个 `pnpm-lock.yaml`。SDK 58 使用 React Native 0.88、React 19.3 和 app 自己的 TypeScript 6.0；版本依据 [Expo SDK 参考](https://docs.expo.dev/versions/latest/)、[官方 TypeScript 指南](https://docs.expo.dev/guides/typescript/) 和 SDK 58 模板。网页继续使用自己的 React 版本。

从仓库根运行：

```sh
pnpm install
pnpm dev:mobile --port 8087                 # 启动 Metro；多个 worktree 使用不同端口
pnpm --filter @mate/mobile typecheck
pnpm --filter @mate/mobile exec expo install --check
pnpm --filter @mate/mobile bundle:check     # 导出 iOS JS/Hermes bundle 到 apps/mobile/dist
```

Metro 使用 [Expo 默认的 monorepo 支持](https://docs.expo.dev/guides/monorepos/)，不需要自定义解析器或 workspace 全局 hoisting。`pnpm typecheck` 包含移动端，CI 在现有格式与类型检查任务里另跑一次 iOS bundle 检查。导出 bundle 不需要原生 SDK，也不证明已在设备上运行。

安装了原生开发工具时，可以构建并启动开发版：

```sh
pnpm --filter @mate/mobile ios --device --port 8087
```

iOS 需要 macOS、包含 iOS 27 SDK 的 Xcode 和 iOS 27 或更新版本的模拟器或设备，工具安装见 [Expo 环境设置](https://docs.expo.dev/get-started/set-up-your-environment/)。共享机器先确认设备未被其他 session 占用，再选择设备。生成的 `ios/` 和 `.expo/` 只留在本地，由 app config 和依赖重新生成。合入原生插件或修改 app config 后，先运行 `pnpm --filter @mate/mobile exec expo prebuild --platform ios --no-install` 再构建；已有 `ios/` 目录不能保证新插件配置已应用。通知构建应确认生成的 `Mate.entitlements` 含所选环境的 `aps-environment`。

最低版本通过 Expo 内置的 [`ios.deploymentTarget`](https://docs.expo.dev/versions/v58.0.0/config/app/#deploymenttarget) 配置为 `27.0`，不需要额外的构建属性插件。`pnpm --filter @mate/mobile exec expo prebuild --platform ios --no-install` 生成的 `ios/Podfile.properties.json` 含 `ios.deploymentTarget: "27.0"`；Xcode 工程的应用 target 在 Debug 和 Release 配置中均为 `IPHONEOS_DEPLOYMENT_TARGET = 27.0`。原生编译和运行验证使用自己的开发版；Expo Go 的宿主部署目标不能证明 Mate 自身的最低版本。

认证沿用控制面的 Secure HttpOnly cookie，无需 bearer API 或 CORS 配置。启动和从后台回到前台重新验证登录，权限弹窗的 inactive → active 不触发重验；连接失败可重试，401 需要重新登录。退出与换服务器会清理 app 的原生 cookie；离线退出仅保证关闭本机访问，并提示远端撤销未确认。地址与恢复标记存在 Expo SQLite 键值设置中，不保存密码。正常使用后的重启恢复依赖原生 cookie 存储，不保证登录后立即强杀的持久化。`expo-sqlite` 和 `@preeternal/react-native-cookie-manager` 需要用上述 `ios` 命令构建开发版或 Release 包，Expo Go 不能验证这个 app 的 cookie 清理集成。

`dev.yyang.mate` 是当前 iOS bundle identifier。签名使用对应的 App ID 和 provisioning profile，控制面的 `MATE_APNS_TOPIC` 也必须与它一致。签名与自用分发方式仍待确认，本阶段不添加公开应用商店发布自动化。根 `pnpm build` 只构建已有网页和服务端包，移动端不参与控制面镜像或 node 发布包的构建。

移动任务 PR 以长期集成分支 `mobile` 为 base，依赖任务可在其上堆叠。合入任务 PR 不发布移动 app，也不触发 `v*` 发布。整体 `mobile` 到 `main` 的集成另等用户批准；本阶段不合并、不打 tag、不发布、不部署。

### 6.2 原生 iOS 通知

原生登记的随机 binding 使用 SDK 58 的 [expo-crypto.randomUUID](https://docs.expo.dev/versions/v58.0.0/sdk/crypto/)，不依赖浏览器的 Web Crypto 全局对象。

移动端使用 [expo-notifications SDK 58](https://docs.expo.dev/versions/v58.0.0/sdk/notifications/) 的原生 APNs token。SDK 58 的[官方依赖表](https://github.com/expo/expo/blob/sdk-58/packages/expo/bundledNativeModules.json) 推荐 `~58.1.6`。服务端使用维护中的 [@parse/node-apn 8.1.0](https://github.com/parse-community/node-apn)，其 Node 范围包含 24。选择直接 APNs，是因为已有后端可以持有 provider，避免另加 Expo 托管推送服务与账号。[Expo 官方说明](https://docs.expo.dev/push-notifications/sending-notifications-custom/)允许直接 APNs；Expo 推送服务还需要 Expo token、服务与凭据管理，本项目不使用它。库负责 HTTP/2 与 JWT，Mate 只适配现有队列。

未配置时 Web Push 照常运行，`GET /api/chat/push/native` 返回 `{ enabled: false }`，原生订阅回 503 `native-push-disabled`。系统权限允许也不会显示已登记。配置 APNs 时，控制面需要同时提供以下环境变量；只提供一部分或 key 无法加载时拒绝启动。

| 变量 | 内容 |
| --- | --- |
| `MATE_APNS_KEY_FILE` | 由操作者提供的 APNs `.p8` key 文件路径，控制面可读；容器中可只读挂载，不提交到仓库 |
| `MATE_APNS_KEY_ID` | Apple 签发的 10 位 key ID |
| `MATE_APNS_TEAM_ID` | 10 位 team ID |
| `MATE_APNS_TOPIC` | 签名 app 的 bundle identifier，当前为 `dev.yyang.mate` |
| `MATE_APNS_ENVIRONMENT` | `sandbox` 或 `production`，不从 `NODE_ENV` 猜测 |
| `MATE_PUBLIC_ORIGIN` | 与 app 保存地址完全相同的 HTTPS origin，不含末尾 `/` 或路径 |

app config 的输入 `MATE_IOS_APNS_ENVIRONMENT` 缺省为 `sandbox`。它同时设置 Expo 通知插件的 entitlement mode 和 app 订阅的环境。正式签名包使用 `production`；Xcode archive 也会把 entitlement 改为 production，构建输入必须与之匹配。改变输入后重新 prebuild 并正常构建，不修改生成的二进制。服务器拒绝环境不匹配的登记；app 拒绝服务器公布的 origin 或环境与自己不一致。

`apns.ts` 的 provider 连接由进程持有，关闭时释放。单次投递总期限 10 秒，库内重试关闭。暂时失败仍按聊天队列的退避计划重试，过期 provider token 也重试。只有 token 失效相关的拒绝才删除设备订阅，provider 配置错误不清理 token。APNs 的 expiry 固定为消息时间加一天；队列重试不延长它。已过期的消息不再交给 APNs。collapse ID 沿用消息 tag，通知数据不含消息正文。系统提示使用通用文案，点击数据带精确 server、accountId 和随机登记 binding，避免在错误身份下打开旧通知。

关闭通知、退出、换服务器和登录失效会尝试取消服务器登记，再清 cookie，并向 iOS 取消本机注册、清除已展示通知。离线时无法保证旧服务器立即停止或撤回已交给 APNs 的通知；界面说明取消未确认。退出之后才到达的登记请求回 401；重新开启和 token 轮换使用新 binding。未确认的旧 token 取消记录独立于当前登记保存，token 轮换和新登记不会覆盖它们；下次同一服务器和账号恢复验证、刷新或退出时重试，只有服务端确认后才删除。重新允许注册之后仍可能收到旧服务器的通用提示；旧数据不会打开当前其他账号或服务器的会话。

实际远程投递仍需操作者确认付费 Apple Developer 资格，提供 APNs 凭据，并生成具有 Push Notifications capability 的签名 app。本任务不创建或修改 Apple Developer、EAS 账号或资源，不接触真实 key 内容，不向真实账号发送测试通知。普通 iOS 27 模拟器的正常构建、系统权限界面和 `simctl push` 注入可验证本机行为；模拟注入不是 APNs 或真机投递证明。没有凭据和签名之前，真实 APNs 投递保持未验证。

合入聊天任务时保留根层的 `NotificationIntegration`，并在账号或资料入口链接 `/notifications`。点击目标是 `/conversation`，参数为 `id`、可选 `thread` 和 `seq`；聊天任务的已登录路由组持有该页面，通知任务不创建另一套聊天导航。需在整体 mobile 合入后验证最终页面与序号定位。
