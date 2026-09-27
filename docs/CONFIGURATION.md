# 部署配置

Mate 的部署配置是一个 JSON 文件，只描述**启动位置**：所有者网页里管理的 Agent、频道、成员与模型服务凭据不写在这里。模板见仓库根目录的 `mate.deploy.example.json`，完整安装步骤见[Debian 部署与运维](OPERATIONS.md)。

配置里的每个路径都属于运行 Mate 的那个现有普通账号，全部是绝对路径：

- `publicOrigin`：所有者访问的 HTTPS 原点。Mate 只把它用于网页链接与通知落点，不配置证书；HTTPS 由宿主的反向代理负责。
- `controlPlanePort`：控制面监听端口，绑定 `127.0.0.1`，1024–65535。外部访问经宿主反向代理。
- `releaseRoot`：发布目录根。Mate 在其中建立 `releases/<内容摘要>` 与 `current` 符号链接。
- `stateDir`：进程记录、日志与检查点目录。必须只有运行账号可读（Mate 会检查权限）。
- `controlPlaneDataDir` / `nodeDataDir` / `agentHomeRoot`：控制面数据库、节点身份与收据、Agent 默认工作区根目录。
- `ownerPasswordFile`：初始所有者密码文件，`0600` 普通文件，至少 12 字节。控制面首次启动保存 Argon2id 哈希，此后不再需要它。

路径必须互不相同，数据目录不能位于 `releaseRoot` 内。配置里没有需要 root 的目录，也没有需要 Mate 创建的系统账号或 systemd 单元；节点配对令牌由所有者在网页生成，建议放在自己管理的私有环境文件里，配对成功后可以删除。

服务是普通子进程：每个服务在 `stateDir` 下有一条进程记录和一个日志文件，Mate 用它们判断真实状态，并在停止未获确认时报出仍在运行的进程号。Mate 不做开机自启与崩溃重启；需要这些由宿主自行安排，且必须与 Mate 自己的 `start` 路径互斥（见运维说明）。
