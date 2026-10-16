# Mate 部署指南（重写版）

> 读者：要把 Mate 装到一台 Linux VPS 上的所有者。
> 配套文档：[ARCHITECTURE.md](ARCHITECTURE.md) 第 6、7 节，[PLAN.md](PLAN.md)。

## 0. 现在能不能部署

**还不能。** 重写完成了 M1–M4（到 node 链路为止）。能在真实环境里跑起来所需的几块还没写：

| 部署需要的东西 | 里程碑 | 现状 |
|---|---|---|
| 聊天 app、Agent runtime、连接器、Agent Manager | M1–M3 | 已完成，只能在测试里以进程内方式运行 |
| node 网关与 node 进程 | M4 | 网关与 node 已实现，并在 Linux 容器里测试；还没有接到控制面进程里 |
| 历史工具、上下文压缩 | M5 | 未完成。缺了它，长时间运行的 Agent 会在上下文写满时出错 |
| 登录、HTTP 路由、实时事件流、推送、管理模块 | M6 | 未开始。没有它就没有可访问的控制面进程（`apps/control-plane` 不存在） |
| 网页前端 | M7 | 未开始 |
| 控制面 Docker 镜像、node 发布包、`mate node` CLI | M8 | 未开始 |
| 起真实进程的端到端场景 | M9 | 未开始 |

下面第 1 到 5 节写的是**目标部署方式**，用来对齐预期，并给 M8 的实现提供规格。标了"待 M8 定稿"的细节沿用旧设计（ADR-0009），实现时可能调整。第 6 节写的是**今天**在开发机上能做什么。

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

## 3. 安装（目标流程，待 M8 定稿）

### 3.1 控制面

1. 建一个只属于你账号的私有数据目录，权限 0700，例如 `~/mate/data`。
2. 拿到同一版本号的控制面镜像和 `compose.yaml`。
3. 首次启动时提供一个初始密码文件（ARCHITECTURE §4.7、MODULE_TESTS 11.1：初始密码文件只在第一次启动时读取）。
4. `docker compose up -d`，用初始密码登录网页，确认能登录后，把初始密码文件从 Compose 配置里去掉。
5. 让反向代理把你的域名转发到控制面端口（旧设计是宿主 `127.0.0.1:8787`）。

### 3.2 node

1. 拿到同一版本号的 node 完整发布包（自带 Node 运行时和 `mate node` CLI，宿主不需要装 Node、pnpm 或编译器），校验 SHA-256。
2. 用包里的安装程序把 CLI 装到 `~/.local/bin/mate`。
3. 在网页的"节点管理"里生成一次性配对令牌，写进 node 配置（旧设计是 `~/.config/mate/node.json`，权限 0600）。同机部署时控制面地址用 `http://127.0.0.1:8787`，不是容器服务名。
4. `mate node install`：安装并启动用户服务。重复执行 `install` 不会重启或重新启用一个被你手动停掉的服务（MODULE_TESTS §9）。
5. 网页显示 node 在线后，从配置里删掉配对令牌。之后 node 用自己的身份签名认证，令牌已经用掉，留着也没用。

### 3.3 第一个 Agent

1. 网页"管理"里填入模型提供商的 API key。
2. 创建 Agent：填显示名、handle、模型。Manager 会依次开聊天账号、让 node 建工作区、建 Agent 文件（ARCHITECTURE §4.4）。
3. 在频道里 @ 它。它会收到一条通知，自己决定读取并回复。

## 4. 日常运维（目标，待 M8 定稿）

| 要做的事 | 怎么做 |
|---|---|
| 看 node 状态、日志 | `mate node status`、`mate node logs` |
| 启停 node | `mate node stop`、`mate node start`。显式 stop 之后保持停止 |
| 看控制面日志、启停 | 在放 `compose.yaml` 的目录里 `docker compose logs -f`、`docker compose stop`、`docker compose start` |
| 暂停或恢复某个 Agent | 网页"管理"。暂停 = 立刻关闭它的 runtime，进行中的模型请求和 node 上的命令都被停掉（网关逐个通知 node 杀掉这些命令的进程组；用 `setsid` 之类脱离进程组的后台进程不受影响）；恢复后从停下的地方接着跑 |
| 看 Agent 在想什么、做了什么 | 网页"管理"里的实时对话记录 |
| 看用量 | 网页"管理"。只用于观察，没有任何配额 |

崩溃和断线不需要人工处理：控制面重启后，Manager 打开所有没暂停的 Agent，从各自存下的位置继续；node 断线时进行中的命令以"结果未知"交给 Agent，node 自己按退避重连（ARCHITECTURE §5.5、§5.6）。

## 5. 数据、备份、更新、卸载

### 5.1 数据在哪

```
<数据目录>/                     控制面容器里的 data/
  control.sqlite               登录、API key、node 注册表
  chat.sqlite                  聊天的全部数据
  attachments/                 附件文件
  agents/<agentId>.sqlite      每个 Agent 的全部状态：对话、配置、提醒、连接器位置、是否暂停
```

node 一侧：node 的身份密钥和配置在 node 账号自己的目录里；每个 Agent 的工作区也在 node 上，不挂载进控制面容器。

一个 Agent 存在，当且仅当它的 `agents/<agentId>.sqlite` 存在。没有别的 Agent 列表需要维护。

### 5.2 备份与搬家

1. 停控制面：`docker compose stop`。
2. 复制整个数据目录（连同 `-wal`、`-shm` 文件）。
3. 在新机器上用同一版本启动，指向复制过去的目录。

node 的工作区按普通文件备份即可。node 换机器时，在新机器上重新配对。

### 5.3 更新

先停 node，再停控制面，两边换成**同一版本**，先启动控制面并确认能登录，再启动 node。

**数据不做迁移**（ADR-0002）。新版本发现某个数据库的结构版本不对时，会拒绝启动并报出文件名，不会改动它。重写期间结构变化很频繁（例如聊天库已经从版本 1 变成版本 2），所以在正式发布之前，每次升级都可能需要换一个新的空数据目录。

### 5.4 卸载

`mate node uninstall` 只删 Mate 的程序和用户服务单元，保留配置、身份、工作区和数据（MODULE_TESTS §9）；中断后重新执行即可完成。控制面用 `docker compose down` 删除容器，数据目录保留。

## 6. 今天在开发机上能做什么

需要 Node 24、pnpm 10；跑 Linux 测试还需要 Docker（macOS 上用 OrbStack 即可）。

```sh
pnpm install
pnpm check          # 格式、类型检查、全部测试（macOS 上会跳过只能在 Linux 上跑的测试）
pnpm test:linux     # 在非 root 的 Linux 容器里跑 node 的测试套件（以子进程启动 node，真实的进程组与文件系统）
```

还没有可以手动启动的控制面进程，所以"装起来点一点"要等 M6。现在验证系统是否工作，靠的是各模块的边界测试和 M3 的进程内场景：所有者 @ Agent，Agent 收到通知、读取并回复（`packages/manager/test/scenarios.test.ts`）。

## 7. 正式部署之前还要定的事

见 PLAN.md 的 M5–M9，以及架构文档第 11 节的待定问题（node 安装器的可续做状态机有没有更简单的做法）。
