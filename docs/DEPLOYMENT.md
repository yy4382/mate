# Palace 部署指南

> 读者：部署 Linux 控制面，以及在 Linux、macOS 或 Windows 上安装 node 的管理员。
> 配套文档：[ARCHITECTURE.md](ARCHITECTURE.md) 第 6、7 节。

## 1. 部署形态

```
VPS（Ubuntu 24.04 / Debian 13，x86_64）
│
├─ 控制面：一个 Docker 容器，以一个专用的无登录系统账号（例如 palace-control）的 UID/GID 运行
│    网页、聊天 app、管理模块、Agent Manager、所有 Agent 的 runtime、node 网关
│    数据：宿主上一个只属于这个系统账号的私有 bind 目录 → 容器内 data/
│
├─ node 账号：一个普通账号（例如 palace），不在 docker 组里
│   └─ node：systemd 用户服务（palace-node.service），由 `palace node` CLI 管理
│        在 Agent 的工作区里执行命令、读写文件；主动用 WebSocket 连控制面
│
└─ 你自己已有的 HTTPS 反向代理（Caddy、nginx 等）→ 控制面端口
```

**为什么分两个账号。** Agent 的命令以 node 账号运行。控制面的数据目录里有模型 API key、密码哈希和所有对话；它如果也属于 node 账号，任何 Agent 都能 `cat` 出来。所以数据目录属于另一个账号，node 账号连进入它的权限都没有。同理，node 账号不能在 docker 组里：能用 Docker 就等于宿主上的 root。控制面由 root（或你别的管理账号）用 `docker compose` 管理。

规模按几个人、少量 Agent 设计（ARCHITECTURE §10），一台低配置 VPS 足够，主要开销是模型 API 费用。

Palace 不创建系统用户，不切换身份，不安装系统软件，不改 sudo、Docker 权限或 linger，不装证书或反向代理。Agent 命令里的 `sudo` 能否成功由宿主的 sudo 配置决定。

控制面和 node 可以在不同机器上，node 只需要能访问控制面的地址。控制面部分按 Linux 同机部署来写，§3.2 覆盖三个平台的 node。

## 2. 前提

1. 一台 Ubuntu 24.04 或 Debian 13 的 VPS，x86_64。
2. 一个给 node 用的普通账号（不是 root，不在 docker 组里），例如 `sudo useradd -m -s /bin/bash palace`。node 会以它运行，Agent 的命令也以它运行，所以给它的权限就是你愿意给 Agent 的权限。
3. 一个给控制面用的无登录系统账号，例如 `sudo useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin palace-control`。它只是数据目录的所有者，容器以它的 UID/GID 运行。
4. 一个能用 Docker Engine 和 Docker Compose 的管理账号（root 或你自己的账号）。
5. node 账号有可用的 systemd user manager。如果希望注销后、或开机后 node 也一直运行，需要你自己执行 `sudo loginctl enable-linger <账号>`，Palace 不替你做。
6. 一个域名和 HTTPS 反向代理。浏览器推送（Web Push）和登录 cookie 都需要 HTTPS。
7. 至少一个模型提供商的 API key。管理界面提供 OpenAI（Responses API）和 DeepSeek 两家（ARCHITECTURE 4.6）。

## 3. 安装

### 3.1 控制面

控制面是 `deploy/control-plane/` 里的一个镜像加两个 Compose 文件：`compose.yaml` 是日常配置，`compose.initialize.yaml` 只在第一次启动时叠加，把第一个管理员的初始密码文件和 handle 交给控制面。镜像用 `docker build --file deploy/control-plane/Dockerfile .` 从仓库根目录构建，构建出的镜像带网页前端；发布时由 CI 推到镜像仓库，用确切的版本号，不用 `latest`。

镜像只安装控制面和网页需要的 workspace 包，不含移动端依赖。编译后的 workspace 包保持原样，`pnpm deploy --prod` 在目标架构上装入生产依赖，所以原生模块和包内资源都在，不打包成单个 JavaScript 文件。node 发布包的 JavaScript 由 tsdown 打包。

每个 PR 和 main 都运行同一个发布构建任务，构建 x64 Linux 镜像和 node 发布包，但不发布。下载的 Node 运行时按 `deploy/node/node-runtimes.ts` 缓存。只改了文档（Markdown、MDX、reST、AsciiDoc、`docs/` 下的文件、根目录 LICENSE/NOTICE）时跳过这个任务，其余检查照常。`v*` 标签总是构建并发布。

1. 建一个只属于控制面系统账号的私有数据目录，权限 0700，放在 node 账号进不去的地方，例如 `sudo install -d -m 700 -o palace-control -g palace-control /srv/palace-control-plane/data`。Compose 不会替你建它（目录不存在就拒绝启动），因为让 Docker 建出来的会属于 root。
2. 镜像在 GHCR 上公开，可以匿名拉取，不需要登录。
3. 把 `compose.yaml`、`compose.initialize.yaml` 和 `.env.example`（改名 `.env`）放在同一个目录，填好 `.env`（变量见下表）。`PALACE_UID`、`PALACE_GID` 用 `id -u palace-control`、`id -g palace-control` 查。这个目录和 `.env` 只给管理账号看（例如放在 root 的 `/srv/palace-control-plane`，权限 0700；容器的绑定挂载不受上级目录权限影响）。
4. 写初始密码文件，至少 12 字节（末尾换行不算），属于控制面系统账号，权限 0600，路径写进 `.env` 的 `PALACE_INITIAL_PASSWORD`。第一个管理员的 handle 写进 `PALACE_INITIAL_HANDLE`，缺省 `admin`，可用字母、数字、`_`、`.`、`-`，不分大小写。

   控制面只在库里还没有任何人类时读这两项，用它们建第一个管理员（显示名同 handle），密码只存 scrypt 哈希（ARCHITECTURE §4.7）。第一次启动时缺密码文件或 handle 不合法，控制面拒绝启动。之后由管理员在网页添加其他人，角色是管理员或普通人类，普通人类只能聊天。
5. 第一次启动叠加两个文件：

   ```sh
   docker compose -f compose.yaml -f compose.initialize.yaml up -d --wait
   ```

   用初始 handle 和初始密码登录网页，确认能登录后，删掉初始密码文件，之后只用 `compose.yaml`：`docker compose up -d`。
6. 让 HTTPS 反向代理把你的域名转发到控制面端口（宿主 `127.0.0.1:8787`），配置时注意三点：
   - 保留浏览器请求原来的 `Host`。控制面拒绝 `Origin` 和 `Host` 不一致的写请求（ARCHITECTURE §4.7）。nginx 的 `proxy_pass` 缺省会改写 `Host`，登录会回 403 `cross-origin`，需要加 `proxy_set_header Host $host;`。Caddy 缺省保留 `Host`。
   - 只经 HTTPS 访问。登录 cookie 带 `Secure`，浏览器只在 HTTPS 或 `localhost` 上保存它，Web Push 也需要 HTTPS。
   - 不缓冲 `text/event-stream` 响应。nginx 认控制面发的 `X-Accel-Buffering: no`，其他代理要自己关闭缓冲。控制面每 25 秒发一次心跳，读超时要比这长。

`.env` 里的变量（`compose.yaml` 读它们）：

| 变量 | 含义 | 缺省 |
|---|---|---|
| `PALACE_IMAGE` | 控制面镜像，写确切版本号 | 必填 |
| `PALACE_UID`、`PALACE_GID` | 容器进程的 UID 和 GID，用数据目录的所有者（控制面系统账号） | 必填 |
| `PALACE_DATA` | 宿主上的数据目录，绑定挂载到容器内 `/var/lib/palace` | 必填，目录必须已存在 |
| `PALACE_INITIAL_PASSWORD` | 初始密码文件的宿主路径，只有 `compose.initialize.yaml` 读它 | 第一次启动必填 |
| `PALACE_INITIAL_HANDLE` | 第一个管理员的 handle，只有 `compose.initialize.yaml` 读它 | `admin` |
| `PALACE_LISTEN` | 宿主上监听的地址和端口 | `127.0.0.1:8787` |
| `PALACE_VAPID_SUBJECT` | 见下表 | `mailto:owner@palace.invalid` |

控制面进程读这些环境变量（ARCHITECTURE §4.7）。Compose 已经替你设好，只有 `PALACE_VAPID_SUBJECT` 和（第一次启动时的）`PALACE_INITIAL_HANDLE` 通过 `.env` 改：

| 变量 | 含义 | 缺省 |
|---|---|---|
| `PALACE_DATA_DIRECTORY` | 数据目录（§5.1）；Compose 设成 `/var/lib/palace` | 必填 |
| `PALACE_PORT`、`PALACE_HOST` | 监听的端口和地址；容器里是 `8787`、`0.0.0.0`，由 Compose 只映射到 `PALACE_LISTEN` | `8787`、`127.0.0.1` |
| `PALACE_INITIAL_PASSWORD_FILE` | 初始密码文件，只在第一次启动（还没有任何人类）时读；`compose.initialize.yaml` 设成 `/run/secrets/initial_password` | 无 |
| `PALACE_INITIAL_HANDLE` | 第一个管理员的 handle，同样只在第一次启动时用；`compose.initialize.yaml` 从 `.env` 的 `PALACE_INITIAL_HANDLE` 设入 | `admin` |
| `PALACE_WEB_DIRECTORY` | 构建好的网页前端目录；镜像里是 `/opt/palace/web`；没有时 API 照常，页面回 404 | 无 |
| `PALACE_VAPID_SUBJECT` | 推送服务联系你用的 `mailto:` 或 `https:` 地址，写在每个推送请求的签名里 | `mailto:owner@palace.invalid` |

镜像以非 root 用户运行，`user:` 让 Compose 换成控制面系统账号的 UID/GID，所以数据目录里的文件属于它，node 账号读不到。镜像自带健康检查（带不带会话都能答的 API 路径返回 401 就算健康）。`SIGTERM`（`docker compose stop`）让控制面先断开所有连接，再依次关闭所有 Agent、网关和聊天库后退出，在 Compose 的 10 秒期限内完成。

### 3.2 node

node 支持 x86_64 的 Linux、Apple 芯片的 macOS 和 x64 的 Windows，各有一个发布包。安装、更新、卸载都由 `palace node` 完成，没有单独的安装脚本，也没有下载步骤。管理员把同一版本的 `palace-node-<版本>-<平台>-<架构>.tar.gz` 与旁边的 `.sha256` 下载到 node 机器上；平台名是 `linux`、`darwin`、`win`。包自带 Node 24，宿主不需要安装 Node、pnpm 或编译器。

**第一次安装。** 先校验再解包，运行包内的 CLI。以下版本号只是示例，用实际下载的文件名替换。

Linux：

```sh
sha256sum -c palace-node-0.1.0-linux-x64.tar.gz.sha256
tar -xzf palace-node-0.1.0-linux-x64.tar.gz
./palace-node/bin/palace node install palace-node-0.1.0-linux-x64.tar.gz
rm -r palace-node
```

macOS，在当前账号的图形登录会话内操作：

```sh
shasum -a 256 -c palace-node-0.1.0-darwin-arm64.tar.gz.sha256
tar -xzf palace-node-0.1.0-darwin-arm64.tar.gz
./palace-node/bin/palace node install palace-node-0.1.0-darwin-arm64.tar.gz
rm -r palace-node
```

Windows，在当前账号的 PowerShell 中操作，不需要管理员权限：

```powershell
$bundle = 'palace-node-0.1.0-win-x64.tar.gz'
$expected = (Get-Content "$bundle.sha256").Split(' ')[0]
if ((Get-FileHash $bundle -Algorithm SHA256).Hash -ne $expected) { throw 'Checksum mismatch' }
tar -xzf $bundle
.\palace-node\bin\palace.cmd node install $bundle
Remove-Item -Recurse .\palace-node
```

`install` 自己也校验整个包，再在暂存目录解包检查：只能有普通文件和目录，路径在 `palace-node/` 内，文件与清单 `manifest.json` 一一对应，平台和架构与本机相同。任何一项不通过，已有安装不变。

安装放好程序、命令和服务定义，但不启动服务。POSIX 的命令是 `~/.local/bin/palace` 符号链接；Windows 是 `%LOCALAPPDATA%\Palace\bin\palace.cmd` 普通文件，不需要符号链接特权。CLI 不改用户的持久 PATH；把对应 bin 目录加入自己的 PATH，或使用安装输出中的完整命令路径。

Windows 的已安装命令在更新或卸载时，先把管理入口和运行时复制到 TEMP 下的临时目录，从那里执行，每次留下的运行时副本约 80 MB，管理命令结束后可删除 `%TEMP%\palace-node-cli-*` 目录。这样管理进程不会锁住待替换的 `node.exe`。服务仍直接使用程序目录中的运行时。

**配置和启动。** 在网页的“节点管理”里生成一次性配对令牌，然后运行：

```sh
palace node configure --control-plane https://palace.example.com --pairing-token <令牌>
palace node start
```

同机 Linux 部署可以用 `http://127.0.0.1:8787`，其他机器使用能访问到的控制面地址。`--workspaces <目录>` 可指定工作区根，缺省为账号的 `palace/workspaces`。网页显示 node 在线后，可以不带 `--pairing-token` 再运行一次 `configure` 去掉令牌；留下也无妨，node 每次先用自己的身份签名认证。

**布局和文件保护。** 程序、配置、身份与工作区分开：

| 内容 | Linux | macOS | Windows |
|---|---|---|---|
| 程序目录 | `~/.local/lib/palace-node` | 同 Linux | `%LOCALAPPDATA%\Palace\program` |
| 命令 | `~/.local/bin/palace` | 同 Linux | `%LOCALAPPDATA%\Palace\bin\palace.cmd` |
| 服务定义 | `~/.config/systemd/user/palace-node.service` | `~/Library/LaunchAgents/io.palace.node.plist` | `%LOCALAPPDATA%\Palace\config\node-task.xml`，注册为 `Palace node <账号 SID>` |
| 配置 | `~/.config/palace/node.json` | 同 Linux | `%LOCALAPPDATA%\Palace\config\node.json` |
| 身份和链路 | `~/.local/share/palace/node` | 同 Linux | `%LOCALAPPDATA%\Palace\data` |
| 日志 | 用户 journal | 身份目录内的 `node.log` | 身份目录内的 `node.log` |
| 缺省工作区 | `~/palace/workspaces` | 同 Linux | `%USERPROFILE%\palace\workspaces` |

程序目录包含清单、运行时、许可证、`lib/palace.mjs` 和启动命令。暂存目录在程序目录旁，名字为 `.palace-node-staging-*`、`.palace-node-old-*`。POSIX 的私有目录和文件使用 0700、0600。Windows 依赖当前账号 LOCALAPPDATA 的默认 ACL 隔离其他普通账号；Palace 不用 `chmod` 冒充 ACL 设置，这也不是对管理员或 SYSTEM 的隔离。

`install`、`update`、`uninstall` 只管理程序、命令和服务定义。配置、身份、日志和工作区保留。

**每个命令从现有状态决定动作**（ARCHITECTURE §11 第 1 条），不记录“做到哪一步”。这张表在三个平台都成立：

| 命令 | 看到的状态 | 做什么 |
|---|---|---|
| `install <包>` | 程序目录不存在 | 校验并解包到暂存目录，再改名成程序目录 |
| | 已装同一版本 | 保留程序，补齐缺失的 Palace 命令和服务定义 |
| | 已装另一版本 | 拒绝，提示用 `update` |
| | 程序目录没有可读清单 | 拒绝，不改动它 |
| | 命令或服务定义属于别人 | 保留并报告，不能覆盖或操作那个服务 |
| | 服务正在运行或已被管理员停用 | 不启动、不重启、不重新启用 |
| `update <包>` | 服务运行、过渡中、可能重启或状态不明 | 拒绝；先用 `palace node stop` 停妥 |
| | 程序目录含清单外文件 | 拒绝并列出文件 |
| | 已完全停止且版本不同 | 校验新包，旧目录挪开，新目录改名就位，再删旧目录 |
| | 程序目录不存在 | 按首次安装放好，服务仍保持停止 |
| `uninstall` | 程序目录不是 Palace 的或含清单外文件 | 拒绝，不改文件和服务 |
| | 服务定义属于 Palace，或能确认是 Palace 已加载的服务 | 停用并停止，删除 Palace 的服务定义 |
| | 服务定义属于别人 | 不停它、不删它，输出中报告 |
| | 命令属于 Palace | 删掉；别人的命令保留 |
| | 程序目录存在 | 挪进暂存目录后删除 |
| `start` | 没装、没有服务定义、配置缺失或服务属于别人 | 拒绝 |
| | 其余 | 启用并启动，重复调用收敛到正在运行 |
| `stop` | 服务未安装 | 报告无须停止 |
| | Palace 的服务已存在 | 停用并停止，之后保持停止 |
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
| 卸载 | 停止、删除 Palace 单元、daemon-reload | 停止、删除 Palace plist | 停止、Delete Palace 任务、删除 Palace XML |
| 状态查询 | show 的服务属性 | print 的有限状态和 PID；解析不明按 unknown | COM 的数字状态和实例，CIM 的进程身份，不解析本地化状态文字 |
| 没有可用管理器 | 写文件前失败，提示当前账号需要 user manager | 写文件前失败，提示需要当前账号的 GUI domain | 写文件前失败，保留已有文件 |

中途失败就重跑同一个命令。程序目录要么是完整旧版本、完整新版本，要么不存在。清单外的文件不会被更新或卸载悄悄删除。

**链路。** `node run` 在数据目录的 `link.json` 原子记录 `{ pid, connected, since }`。`palace node status` 只有在服务正在运行，并能核对它的执行进程时才显示 `Link: connected/disconnected since <时间>`；否则显示 `Link: none`。Linux 核对 MainPID，macOS 核对 launchctl PID，Windows 核对任务实例与 CIM 进程路径和创建时间，不能把 Task Scheduler 的 EnginePID 直接当作 node PID。服务运行本身不表示已连接控制面。

**退出与重启。** 没有配置或身份被拒绝时，前台 `node run` 以 78 退出。Linux 用 RestartPreventExitStatus 阻止重启；macOS 的服务入口 `node run --service` 把这个不可重试退出映射为 0，原因仍记入日志。Linux/macOS 的其他失败由服务管理器重启。Windows 计划任务不保证在进程异常退出后重启：原生 CI 中以 1 退出后，`RestartOnFailure` 也未触发重启。因此 Windows node 崩溃后需执行 `palace node start`，或在下次登录时启动。此时任务仍启用，`status` 可能显示 `Service: ready, enabled`，不能据此判断进程是否崩溃；`Link: none` 表示没有已确认的链路。计划任务只在当前账号登录时运行，不保存账号密码，不切换到 LocalSystem。

POSIX 管理命令拒绝 root。Palace 不创建账号、不配置 linger、不修改 Windows ACL，也不授予提权能力。

### 3.3 第一个 Agent

1. 网页"管理"里填入模型提供商的 API key。
2. 创建 Agent：填显示名、handle、模型。Manager 会依次开聊天账号、让 node 建工作区、建 Agent 文件（ARCHITECTURE §4.4）。
3. 在频道里 @ 它。它会收到一条通知，自己决定读取并回复。

## 4. 日常运维

| 要做的事 | 怎么做 |
|---|---|
| 看 node 状态、日志 | `palace node status`（版本、服务状态、链路、配置，不打印令牌）、`palace node logs [--lines <n>] [--follow]` |
| 启停 node | `palace node stop`（停止并停用）、`palace node start`（启用并启动）。stop 之后保持停止，重复 `install` 也不会启动它 |
| 看控制面日志、启停 | 在放 `compose.yaml` 的目录里 `docker compose logs -f`、`docker compose stop`、`docker compose start`。日常命令只用 `compose.yaml`，不叠加 `compose.initialize.yaml` |
| 暂停或恢复某个 Agent | 网页"管理"。暂停立刻关闭它的 runtime，停掉进行中的模型请求和 node 上能追踪到的命令（例外见 ARCHITECTURE 4.5）。恢复后从停下的地方继续 |
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
2. 复制整个数据目录（连同 `-wal`、`-shm` 文件），保留所有者，例如 `sudo cp -a /srv/palace-control-plane/data /srv/palace-control-plane/backup-$(date +%F)`。
3. 在新机器上用同一版本启动，`.env` 的 `PALACE_DATA` 指向复制过去的目录。数据库里已有密码，所以不需要 `compose.initialize.yaml`。

node 的工作区按普通文件备份即可。node 换机器时，在新机器上重新配对。

### 5.3 更新

先停 node，再停控制面，两边换成同一版本，先启动控制面并确认能登录，再启动 node。node 一侧：

```sh
palace node stop
palace node update palace-node-0.2.0-linux-x64.tar.gz   # 服务没完全停止时拒绝，什么都不改
palace node start
```

`update` 之后服务保持停止。程序目录里如果有你自己放的文件，`update` 会拒绝并列出它们，挪走后重跑。

**Linux/macOS 的命令 shell。** node 账号的默认 shell 必须是 Bash 或 zsh。命令使用账号的主目录作 HOME，并带上它的交互启动配置；node 进程只读一次启动文件，修改后（或启动配置出错后）重启 node 生效。控制面先升级时，旧 node 仍按原方式（`/bin/sh`、工作区作 HOME）执行，直到它也升级。

**数据原地迁移**（ARCHITECTURE §6、§11 第 8 条）。新版本启动时把数据库升到自己的结构版本，迁移在一个事务里，失败就回滚、拒绝启动并报出文件名，数据库留在旧版本。数据库比程序新、或停在新版本不认识的版本时同样拒绝启动，不改动它。升级到会迁移数据的版本之前，先备份数据目录：迁移成功后旧版本拒绝启动（数据库比程序新），所以回退就是换回旧镜像并恢复这份备份，没有别的办法；备份之后写入的数据随之丢失。

1. `docker compose down`，复制一份数据目录作备份（回退要用它）。
2. `.env` 里改 `PALACE_IMAGE`，其余不动。
3. 只用 `compose.yaml` 起新版本：`docker compose up -d --wait`（初始化用的 `compose.initialize.yaml` 不再叠加，库里已有人类）。需要回退时，`docker compose down`，把 `PALACE_IMAGE` 换回旧镜像，用第 1 步的备份替换数据目录，再起旧版本；不要让旧版本直接打开已迁移的数据目录。

**从只有一个所有者的版本（v0.1.0-alpha.2 及以前）升级。** 原来的所有者在升级后成为管理员：handle 是 `owner`，显示名 `Owner`，密码不变，已登录的浏览器继续有效，这个账号的会话、未读和推送订阅都在。所以升级不需要初始密码文件，`PALACE_INITIAL_HANDLE` 也不起作用（库里已经有人类）；用 handle `owner` 登录，之后可以自己改显示名和 handle，也可以添加别的人类。

### 5.4 卸载

`palace node uninstall` 停止并停用服务，删除程序目录、Palace 命令和服务定义，保留配置、身份和工作区。中断后重新执行即可完成。它只删 Palace 的东西：程序目录里有清单外的文件时拒绝并列出它们；不是 Palace 写的单元文件或 `palace` 命令保留不动，也不停用它们定义的服务，只在输出中报告。控制面用 `docker compose down` 删除容器，数据目录保留。

### 5.5 自动部署

控制面和 node 在同一台 Linux 机器上时，CI 可以在每次发版后自动升级。在 main 的提交上推送 `v*` 标签即发版。发版任务不重跑检查，而是等这个提交在 main 上的 `checks` 通过，没通过就不发版；这时先重跑 main 上失败的任务，再重跑发版任务。

镜像和发布包发布之后，`.github/workflows/ci.yml` 的 Deploy 任务用一把专用 SSH key 连到这台机器，执行 `deploy/auto-update/palace-deploy`，完成 5.3 的步骤。没有预发环境，所以每次部署都先备份数据目录，失败就自动回退。

`palace-deploy` 以 root 运行，从 SSH 拿到 `deploy <版本> <sha256>`，从标准输入拿到这台机器架构的 node 发布包：

1. 校验发布包，拉取 `PALACE_IMAGE_REPO:<版本>` 镜像。已经是这个版本时什么都不做。
2. 停 node，`docker compose down`，把数据目录复制到 `<控制面目录>/backups/before-<版本>-<时间>`。
3. 改 `.env` 的 `PALACE_IMAGE`，`docker compose up -d --wait`，等控制面健康，即 `/api/me` 回 401、`/login` 回 200，最多等 `PALACE_HEALTH_WAIT` 秒（默认 30）。
4. `palace node update` 新发布包，`palace node start`，每秒看一次 `palace node status`，最多等 `PALACE_NODE_CONNECT_WAIT` 秒（默认 60）出现 `Link: connected`。超时则打印 node 日志并回退。node 连上后再确认一次控制面健康。
5. 保留最近 `PALACE_KEEP_BACKUPS` 份备份，以及新旧两个版本的发布包（在 `/var/lib/palace-deploy/bundles/`）。每次部署的输出也追加到 `/var/lib/palace-deploy/deploy.log`；CI 中途断开时部署照常做完或回退，结果看这里。

第 2 步之后任何一步失败，都回到原来的镜像，用刚才的备份替换数据目录，把 node 换回原来的发布包并启动（原来的版本可能还没有 `Link:` 行，所以这里只等控制面健康，不等链路），然后以失败退出，CI 里这次部署显示为失败。回退要用正在运行的那个版本的发布包，所以第一次启用前要把它放进 `/var/lib/palace-deploy/bundles/`（连同 `.sha256`），没有它时 `palace-deploy` 不动手。同一时间只有一次部署在跑。

**设置**（在这台机器上，以 root）：

```sh
install -m 0755 deploy/auto-update/palace-deploy /usr/local/sbin/palace-deploy
install -m 0600 deploy/auto-update/palace-deploy.env.example /etc/palace-deploy.env   # 按实际路径改
install -d -m 0700 /var/lib/palace-deploy/bundles
cp palace-node-<当前版本>-linux-x64.tar.gz* /var/lib/palace-deploy/bundles/
ssh-keygen -t ed25519 -N '' -C palace-deploy -f palace-deploy-key   # 私钥交给 GitHub 后删掉
echo "restrict,command=\"/usr/local/sbin/palace-deploy\" $(cat palace-deploy-key.pub)" >> /root/.ssh/authorized_keys
```

`restrict,command=` 让这把 key 只能执行 `palace-deploy`，没有 shell、转发和终端；拿到它的人最多能把这台机器升级到一个已发布的版本。GitHub 仓库里建一个 `production` 环境，放三个 secret：`DEPLOY_HOST`（例如 `root@203.0.113.7`）、`DEPLOY_SSH_KEY`（私钥）和 `DEPLOY_KNOWN_HOSTS`（`ssh-keyscan` 得到、和你已知的主机指纹核对过的那一行）。主机地址、key 和主机指纹只放在这里，不写进仓库，Action 日志里也被遮掉。没有 `DEPLOY_HOST` 时 Deploy 任务什么都不做。

### 5.6 从 1Password 通过标准输入提供 APNs 私钥

需要避免在服务器文件系统保存 APNs `.p8` 时，可以让宿主机上的 systemd 管理控制面。每次启动由 `palace-apns` 使用 1Password CLI 读取一次 Document，成功后通过匿名管道交给容器的标准输入，由控制面解析并验证 EC P-256 私钥。`PALACE_APNS_KEY_STDIN=1` 让控制面接收这份 PKCS#8 PEM 输入；读到 `-----END PRIVATE KEY-----` 就开始启动，不等待 Docker 关闭标准输入。原有 `PALACE_APNS_KEY_FILE` 仍适用于文件部署，两种输入不能同时设置。

这个模式要求 Linux、Docker Compose、systemd、1Password CLI 2.18+ 和关闭 swap。宿主脚本及容器都禁用 core dump。私钥不会写入文件、命令参数、Compose 环境变量或 Docker 容器配置。root 仍能读取进程内存。Service Account token 是宿主机持久凭据，由 root 持有，容器只收到 APNs 私钥。

首次启用前，先通过原有 Compose 部署流程发布并验证支持 `PALACE_APNS_KEY_STDIN` 的控制面版本，之后才安装以下脚本、启用 override 和 systemd。启用此模式后，后续部署的回退镜像也必须支持 stdin 输入；若要回退到不支持的旧镜像，须先停止 systemd 服务，移除 stdin override 和 `PALACE_PLANE_SERVICE` 配置，恢复原有 Compose 管理方式。

先创建专用 vault、保存 APNs Document，并创建只读 Service Account。将 token 保存在 `/etc/palace-secrets/1password-token`，文件属主 root、权限 0600，父目录权限 0700。通过交互式隐藏输入写入，避免把 token 写进命令历史。以下安装文件必须来自经过审阅的 Git 提交。

```sh
install -m 0755 deploy/auto-update/palace-apns /usr/local/sbin/palace-apns
install -m 0600 deploy/auto-update/palace-apns.env.example /etc/palace-apns.env
install -m 0644 deploy/auto-update/palace-control-plane.service /etc/systemd/system/palace-control-plane.service
```

编辑 `/etc/palace-apns.env`，填入实际控制面目录、vault ID 和 Document ID。将 `deploy/control-plane/compose.apns.yaml` 合并到部署目录的 `compose.override.yaml`，保留已有 override 设置。它设置 `restart: "no"`、`stdin_open: true`、`tty: false`，并禁用容器 core dump。在 Compose 的 `.env` 中填写非私钥配置 `PALACE_APNS_KEY_ID`、`PALACE_APNS_TEAM_ID` 和 `PALACE_APNS_TOPIC`。这个示例使用 production APNs。

```sh
systemctl daemon-reload
# 在实际控制面部署目录中执行。首次切换先停止 Docker 管理的旧容器。
docker compose down
systemctl enable --now palace-control-plane.service
```

`palace-apns /etc/palace-apns.env` 在取密钥成功后用 Compose 创建控制面容器，附加标准输入并运行它。取密钥的输出暂存在未导出的 shell 变量中；只有 1Password 命令成功后才交给 Docker，避免把失败请求的部分输出作为私钥传入。systemd 在输入准备好后收到 ready 通知，自动部署的健康检查从这时开始。容器退出时，systemd 重新运行整个流程并取新密钥。服务器重启也走相同流程。只对这个服务使用 systemd 管理重启，其他容器继续使用各自策略。

自动部署的 `/etc/palace-deploy.env` 增加：

```sh
PALACE_PLANE_SERVICE=palace-control-plane.service
```

新版本部署停止 systemd 服务并按 5.5 备份、更新、启动、检查和回退。取密钥失败就是启动失败，会触发部署回退；回退也需要重新取密钥，因此 1Password 持续不可用时回退同样无法启动。服务会每 10 秒重试。已经运行的 Palace 不依赖后续 1Password 请求；它异常退出或主机重启后，需要 1Password 可用才能恢复。相同版本的部署保持原有 no-op 行为。手动轮换密钥使用 `systemctl restart palace-control-plane.service`。

更换 Apple key 时，同时更新 1Password Document 和 Compose 中的 Key ID。需要更改 topic、team 或环境时同步修改对应配置。部署配置更新也应先提交 Git，再安装到服务器。查看状态使用 `systemctl status palace-control-plane` 和 `journalctl -u palace-control-plane`，不要输出 token、Document 内容或私钥环境。

## 6. 在开发机上运行

需要 Node 24、pnpm 10；跑 Linux 测试还需要 Docker（macOS 上用 OrbStack 即可）。node 的执行与 CLI 测试在 Linux、macOS、Windows 上运行，CI 的 macOS/Windows 任务另外构建本机发布包并验证真实服务。真实服务冒烟只在一次性 CI 账号上显式启用，日常 `pnpm check` 不安装开发机的服务。

```sh
pnpm install
pnpm check          # 格式、类型检查、全部测试（只跳过明确限定其他平台的测试）
pnpm test:linux     # 在非 root 的 Linux 容器里跑 node 的测试套件（以子进程启动 node，真实的进程组与文件系统）
```

开发机可用 `pnpm bundle:node <版本>` 构建全部三个包；`--platform linux|darwin|win32` 可缩小目标，产物在 `dist/node-bundles/`。自动部署继续只使用 Linux 包，macOS/Windows node 手动安装和更新。

控制面可以在本机启动，前端要先构建，再用 `PALACE_WEB_DIRECTORY` 指给它：

```sh
pnpm --filter "@palace/control-plane..." build
pnpm --filter @palace/web build     # 产物在 apps/web/dist
mkdir -m 700 -p ~/palace-dev && printf '%s\n' '一个至少十二字节的密码' > ~/palace-dev/password
PALACE_DATA_DIRECTORY=~/palace-dev/data PALACE_INITIAL_PASSWORD_FILE=~/palace-dev/password \
  PALACE_WEB_DIRECTORY=apps/web/dist node apps/control-plane/dist/src/main.js
# 浏览器打开 http://localhost:8787 。登录 cookie 带 Secure，只有 localhost 和 HTTPS 上浏览器才保留它，所以不要用局域网 IP。
# 改前端时可以另开 `pnpm --filter @palace/web dev`（Vite 开发服务器，/api 代理到 8787）。
# 也可以直接用 HTTP 客户端：
curl -i -X POST localhost:8787/api/login -H 'content-type: application/json' -d '{"handle":"admin","password":"一个至少十二字节的密码"}'
```

登录返回的 `Set-Cookie` 要原样带在之后的请求里。路由见 ARCHITECTURE §4.7。各模块的边界测试是验证系统的主要手段，`apps/control-plane/test/composition.test.ts` 以真实 HTTP 跑通"经 HTTP 配对 node、创建 Agent、管理员私信它、它回复并推送"。

### 6.1 原生移动客户端

`apps/mobile` 是自用的 iOS 27+ Expo app（SDK 58，React Native 0.88，React 19.3，TypeScript 6.0），连接一个 HTTPS 控制面，用已有 handle 和密码登录。依赖从仓库根安装，与网页共用一个 `pnpm-lock.yaml`，网页使用自己的 React 版本。

从仓库根运行：

```sh
pnpm install
pnpm dev:mobile --port 8087                 # 启动 Metro；多个 worktree 使用不同端口
pnpm --filter @palace/mobile typecheck
pnpm --filter @palace/mobile exec expo install --check
pnpm --filter @palace/mobile bundle:check     # 导出 iOS JS/Hermes bundle 到 apps/mobile/dist
```

Metro 使用 [Expo 默认的 monorepo 支持](https://docs.expo.dev/guides/monorepos/)，不需要自定义解析器或全局 hoisting。`pnpm typecheck` 包含移动端，CI 的格式与类型检查任务另跑一次 `bundle:check`。导出 bundle 不需要原生 SDK，所以它不能说明 app 能在设备上运行。

安装了原生开发工具时，可以构建并启动开发版：

```sh
pnpm --filter @palace/mobile ios --device --port 8087
```

iOS 需要 macOS、包含 iOS 27 SDK 的 Xcode 和 iOS 27 或更新版本的模拟器或设备，工具安装见 [Expo 环境设置](https://docs.expo.dev/get-started/set-up-your-environment/)。共享机器先确认设备没有被其他 session 占用。生成的 `ios/` 和 `.expo/` 只留在本地，由 app config 和依赖重新生成。合入原生插件或修改 app config 后，先运行 `pnpm --filter @palace/mobile exec expo prebuild --platform ios --no-install` 再构建，已有的 `ios/` 目录不会自动应用新配置。构建通知相关改动时，确认生成的 `Palace.entitlements` 含所选环境的 `aps-environment`。

最低版本由 app config 的 [`ios.deploymentTarget`](https://docs.expo.dev/versions/v58.0.0/config/app/#deploymenttarget) 设为 `27.0`，prebuild 把它写进 Podfile 配置和 Xcode 工程。Expo Go 不带 app 用到的 cookie 管理原生模块，验证要用上面的命令构建开发版。登录、恢复和退出的行为见 ARCHITECTURE 的移动端部分。

iOS bundle identifier 是 `dev.yyang.palace`，签名用对应的 App ID 和 provisioning profile，控制面的 `PALACE_APNS_TOPIC` 也必须与它一致。根 `pnpm build` 不构建移动端，发布走下面的 TestFlight 流程。

#### 发布 TestFlight（asc）

用 [asc CLI](https://github.com/rorkai/App-Store-Connect-CLI) 完成，不需要 App Store Connect 网页或 Xcode Organizer。`.asc/workflow.json` 定义四个阶段：归档、导出、上传、分发。每个阶段可单独重跑，失败时从失败的阶段继续。命令在仓库根目录运行，需要完整 Xcode、CocoaPods 和项目指定的 pnpm。

**登录。** `asc auth status` 应显示一个登录配置。没有时，用 App Store Connect API key（App Manager 角色，不是 APNs 的 `.p8`）登录，凭据存入 macOS 钥匙串：

```sh
asc auth login --name Palace --key-id KEY_ID --issuer-id ISSUER_ID --private-key /path/to/AuthKey_KEY_ID.p8
```

受限执行环境可能读不到钥匙串，判定未登录前先在正常终端重试。签名另需本机 Xcode Settings → Accounts 登录签名团队，asc 登录不能代替。

**1. 归档。** 查询下一个可用的 build number，写入 `apps/mobile/app.config.ts` 的 `ios.buildNumber`（必要时同时改 `version`）并提交，再归档：

```sh
asc builds next-build-number --app 6830581872 --platform IOS --output json
asc workflow run ios-archive
```

脚本只构建 Git `HEAD`，未提交的改动不会进入发布包。每次运行都在 `artifacts/ios/release.XXXXXX/` 导出独立源码，用锁定的依赖生成 iOS 工程并做 Release 设备归档，APNs 环境固定为 `production`。版本号只改 app config；生成工程会在下次 prebuild 时被覆盖。发布目录中：

- `commit.txt`、`app-config.json`、`toolchain.txt`、`Podfile.lock`、`archive.log` 记录这次构建用了什么。
- `Palace.xcarchive` 含应用和 dSYMs。脚本下载与所装 React Native、Hermes 版本对应的官方 dSYM，核对 UUID 与归档二进制一致后放进 archive。
- `source/`、`DerivedData/`、`symbols/` 是中间产物。

如果 `HEAD` 与已有归档的差异不影响 app，可以直接从导出继续。

**2. 导出 IPA。** `RELEASE_DIR` 填脚本打印的目录，不要取“最新”目录：

```sh
RELEASE_DIR="/absolute/path/to/artifacts/ios/release.XXXXXX"
asc workflow run ios-export RELEASE_DIR:"$RELEASE_DIR"
```

`scripts/ios-export-options.plist` 让 Xcode 按 App Store Connect 分发重新签名，但不改构建号。导出步骤把系统工具目录放在 PATH 最前，因为 Homebrew 的 rsync 与 Xcode 不兼容，会报 `--extended-attributes: unknown option`。

**3. 上传。** 上传后等待 Apple 处理，结果写入 `upload.json`，其中有 build ID 和 `processingState`：

```sh
asc workflow run ios-upload RELEASE_DIR:"$RELEASE_DIR"
```

超时或断线不代表上传失败。重传之前，先用 `asc builds info --app 6830581872 --version VERSION --build-number NUMBER --platform IOS` 查这个构建是否已经存在。`asc builds uploads list` 中停在 `AWAITING_UPLOAD` 且没有文件的记录，说明上传没有完成，可以重新上传。被 Apple 判为无效时，修复后用新的 build number 重新归档。app config 的 `ITSAppUsesNonExemptEncryption=false` 基于 app 只用系统 HTTPS 和 CryptoKit；引入其他加密实现时重新核对。

**4. 分发给内部测试组。** 构建处理完成（`VALID`）后，把它加入 `Palace Internal`（ID 用 `asc testflight groups list --app 6830581872` 查）：

```sh
asc workflow run ios-distribute BUILD_ID:BUILD_ID GROUP_ID:GROUP_ID
```

workflow 最后读回测试组关系，确认构建已在组内，这就是发布完成的判断。内部测试不需要 Beta App Review，测试者在 TestFlight 收到更新；崩溃和反馈可以之后用 `asc testflight crashes` / `asc testflight feedback` 查看。外部测试和 App Store 上架不在这个流程内。

**记录与清理。** 发布后在 `commit.txt` 的提交上打 `ios-testflight-VERSION-BUILD` 标签，只用于追溯，不会触发 §5.5 的服务端部署。之后可以删除 `source/`、`DerivedData/`、`symbols/`，保留 archive（它是这个 build 的二进制记录，日后重建可能解析出不同的 Pods）、IPA、`export.json`/`upload.json` 和上面列出的构建记录。

### 6.2 原生 iOS 通知

app 用 `expo-notifications` 取得原生 APNs token，控制面用 `@parse/node-apn` 直接连 APNs，不使用 Expo 推送服务，所以不需要 Expo 账号和 Expo token。

控制面不配置 APNs 时 Web Push 照常运行，`GET /api/chat/push/native` 返回 `{ enabled: false }`，原生订阅回 503 `native-push-disabled`，app 不会显示已登记。配置 APNs 时要提供一种私钥输入，以及 Key ID、Team ID、topic 和环境。只提供一部分，或 key 无法加载，控制面拒绝启动。

| 变量 | 内容 |
| --- | --- |
| `PALACE_APNS_KEY_FILE` | 由操作者提供的 APNs `.p8` key 文件路径，控制面可读；容器中可只读挂载，不提交到仓库 |
| `PALACE_APNS_KEY_STDIN` | 设置为 `1` 从标准输入读取私钥，与 `PALACE_APNS_KEY_FILE` 二选一；PKCS#8 PEM 输入上限 16 KiB，须在 15 秒内收到完整结束标记，无需关闭 stdin，详见 §5.6 |
| `PALACE_APNS_KEY_ID` | Apple 签发的 10 位 key ID |
| `PALACE_APNS_TEAM_ID` | 10 位 team ID |
| `PALACE_APNS_TOPIC` | 签名 app 的 bundle identifier，当前为 `dev.yyang.palace` |
| `PALACE_APNS_ENVIRONMENT` | `sandbox` 或 `production`，不从 `NODE_ENV` 猜测 |

app config 的输入 `PALACE_IOS_APNS_ENVIRONMENT` 缺省为 `sandbox`，它同时决定通知 entitlement 和 app 订阅的环境。TestFlight 包按 App Store Connect 分发重新签名后是 `production`，所以 `archive-ios.sh` 固定用 `production` 构建，控制面的 `PALACE_APNS_ENVIRONMENT` 也要设为 `production`。开发版用 `sandbox`。改变这个输入后要重新 prebuild 再构建。服务器拒绝环境不匹配的登记，app 也拒绝环境与自己不一致的服务器。

发送、重试和过期见 ARCHITECTURE 的“原生推送发送器”，app 侧的登记与取消见 `MobileNotifications` 一段。模拟器和 `simctl push` 只能验证本机的权限和展示，真实 APNs 送达要在真机上登录、开启通知，再用私信或提及验证。
