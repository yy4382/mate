# Linux 运行与运维（普通账号）

生产运行只使用控制面 Docker 镜像/Compose 与现有普通账号目录中的 node 完整包。薄 bootstrap 获取并安装管理 CLI，随后用 `mate node` 管理用户服务；源码构建和直接进程入口仅用于[本地开发](DEVELOPMENT.md)。两个组件选择同一明确发布版本。首次发布与 VPS 部署仍需单独执行，验证完成不代表产物已经发布。

控制面拥有模型凭据、Pi 循环和唯一 Agent session；node 拥有宿主工作区、普通命令及收据。两者使用同一现有非零 UID/GID。Mate 不创建账号、安装系统软件、切换 Unix 身份或修改 sudo、Docker 权限、linger。Agent 的命令是该账号的普通 shell 子进程，命令中显式 `sudo` 的结果由宿主已有策略决定。

## 安装与配对顺序

1. 准备 Ubuntu 24.04 或 Debian 13 的 x86_64/arm64 普通账号，现有 Docker Engine/Compose 和可用的 systemd user manager。完整包包含专用 Node 和原生依赖，运行宿主不需要 Node、pnpm 或编译器。完整包扫描得到的系统库底线与平台证据见[完整包说明](NODE_BUNDLE.md)和[验收说明](DEPLOYMENT_ACCEPTANCE.md)。
2. 按[控制面部署](CONTROL_PLANE_DEPLOYMENT.md)取得明确版本镜像，准备当前账号持有的私有 bind 目录和首次密码文件，用初始化 Compose 启动并成功登录。成功登录后去掉初始化 override、密码挂载和环境配置；后续重建读取已有密码哈希。
3. 按[完整包说明](NODE_BUNDLE.md)用本地包与可信 SHA-256，或现有 `gh` 的临时私有 Release 鉴权，运行薄 bootstrap。下载凭据只用于本次获取，不进入 node 配置、用户服务或 Agent 环境。私有镜像登录由用户预先完成。
4. 网页“节点管理”生成一次性配对令牌，按[用户服务说明](NODE_SERVICE.md)写入 `~/.config/mate/node.json`，再执行 `~/.local/bin/mate node install`。同机 URL 是 `http://127.0.0.1:8787`，不能使用容器服务名。网页确认原节点在线后移除配置中的令牌。
5. 通过中文网页创建 Agent、配置控制面模型凭据并发送消息。Agent 的工作区属于原宿主账号，不挂载到控制面。浏览器通过宿主已有 HTTPS 代理访问公开原点；域名、证书、WSS 与 Web Push 沿用[配置说明](CONFIGURATION.md)，Mate 不另装代理或证书服务。

安装程序成功、用户服务启动与网页节点在线是三个可分别观察的事实。CLI 报告真实服务状态，网页和 journal 确认配对/在线。配对失败保留原身份，在同一配置换新令牌后 restart；控制面暂时不可达时排查 URL、端口、HTTPS 和容器日志，不删除身份建立替代节点。

## 位置、环境与日常管理

| 内容 | 实际位置或入口 |
| --- | --- |
| 唯一 CLI | `~/.local/bin/mate` |
| 完整程序、CLI 和专用运行时 | `~/.local/lib/mate-node/versions/<版本>` |
| 私有 node 配置 | `~/.config/mate/node.json`，0600；目录 0700 |
| 用户单元 | `~/.config/systemd/user/mate-node.service` |
| node 身份与收据 | 默认 `~/.local/share/mate/node`；可由配置改为独立绝对路径 |
| Agent 默认工作区 | 默认 node 数据目录的 `agents` 子目录；可配置独立绝对路径 |
| 控制面数据库、模型凭据和附件 | Compose `.env` 中 `MATE_CONTROL_PLANE_DATA_DIR` 指定的私有宿主 bind 目录 |
| node 日志 | 宿主已有用户 journal，`mate node logs` |
| 控制面日志 | `docker compose -f compose.yaml logs`，使用宿主现有日志策略 |

用户自行把 `~/.local/bin` 加入 PATH，绝对 CLI 路径一直可用。用户服务直接使用所选包内 Node 与 node 的绝对路径，不加载交互 shell 启动文件。Agent 命令仍使用账号既有宿主工具环境；专用 Node 不加入系统 PATH。服务环境由用户在已有 systemd drop-in 配置，CLI 会拒绝改写包/配置执行引用的冲突。

```sh
~/.local/bin/mate --version
~/.local/bin/mate node status
~/.local/bin/mate node logs --lines 100
~/.local/bin/mate node stop
~/.local/bin/mate node start
~/.local/bin/mate node restart

# 在保存交付 Compose 与私有 .env 的目录操作控制面。
docker compose -f compose.yaml logs --tail 100 -f
docker compose -f compose.yaml stop
docker compose -f compose.yaml start
```

node 异常退出由用户服务重启；显式 stop 保持停止。重复 install 不重启现有服务、不撤销停止或 disabled 选择。`enable` 仅使该账号 user manager 启动目标包含服务；注销后及开机运行还取决于用户自己预配置的 linger。Mate 只读当前事实，不配置 linger；缺 user manager 时服务命令明确失败，bootstrap 与版本命令仍可用。

## 手动更新、恢复与卸载

按[node 停机更新](NODE_UPDATE.md)先停止 node，再停止控制面，取得并校验两侧同版产物，CLI 同步更换管理程序、专用 Node 和 node，Compose 更换镜像；先显式启动控制面，确认可登录后再显式启动 node。更新保持停止，保留 enabled/disabled 选择、配置、身份、收据和工作区，不迁移数据或自动回滚。管理命令持有短暂本机锁，并发 Mate 管理明确拒绝；它不禁止同账号其它程序修改文件，维护时不要同时用原始 systemctl 改服务。

切换、单元发布或 reload 中断后先查看真实状态，再用原参数重试同一 update。公共入口或同版包损坏时，从可信校验后的本地完整包用其专用 Node 调用同一 CLI；清单损坏、未知文件或外来单元保留并拒绝，不通过覆盖隐藏问题。

[node 卸载](NODE_UNINSTALL.md)先停止/禁用并移除 Mate 用户单元，再只删除能由实际库存确认的程序与唯一入口。配置、身份、收据、Agent 工作区以及控制面 bind 数据全部保留。中断后可从保留的本地完整包继续同一 CLI 卸载，重新安装沿用原身份。控制面由所有者 `docker compose -f compose.yaml down` 清理容器和项目网络，bind 数据保留；CLI 不操作 Docker、镜像缓存或宿主软件。

独立实际产物与四平台用户服务验证命令、环境记录以及尚未验收的真实集成项见[部署验收](DEPLOYMENT_ACCEPTANCE.md)。资源数字来自指定演练的过程采样，不是未经测量的最低 VPS 配置。

## 记录与查看任务

在时间线消息的操作菜单、讨论串根消息或回复的操作菜单选择“从消息建任务”，编辑预填的标题后点击“创建任务”即可提交。标题去掉两端空白后须为 1 至 200 字符；同一消息可以继续添加其它任务，回复任务始终挂在所选回复上。消息旁显示全部任务的标题、负责人和状态，“任务看板”保留每项任务及原消息链接。发送时勾选“作为任务发送”只附带一个以消息正文为默认标题的任务。

Agent 用 `tasks.create` 指定原消息与标题建立待认领任务，再用 `tasks.claim` 明确任务 ID 和看到的版本认领。创建返回 `tasks_changed` 时包含当前全部关联任务及 `taskSnapshot` 标记；Agent 可以认领已有任务、协调、放弃，或原样带回标记为另一事项创建。成功创建返回新任务及更新标记。正文变化仍通过现有任务草稿选择处理，更新任务标记不修改草稿中的标题或消息锚点。已完成的调用在同一会话中按操作 ID 返回持久结果。

## 数据与日常接续

控制面 SQLite 是共享事实和每名 Agent 模型历史的唯一持久来源。完整消息按实际呈现顺序追加，包含工具调用、结果、运行中新消息提示和供应商用量。频道、讨论串、私信与重启共用同一逻辑会话。工具调用和结果分别获得控制面持久确认后，才执行工具和继续模型请求。

节点保存身份、工作区和操作收据。断连使旧 run 失去提交资格；重连与进程重启从控制面已确认的原会话继续，并按操作 ID 核对收据。无法确认的副作用作为新事实提供给 Agent，由它选择检查、补救或继续；运行时不自动重放未知操作，也不解除人工暂停。

模型上下文接近容量时，运行进程请求摘要，控制面确认摘要与保留起点后才采用压缩上下文；原始完整历史仍保留。摘要连续失败或无法合法切分时，网页动态提供具体失败原因，所有者修复后重试。累计 token 或费用不触发停工。

完整包的实际手动更新入口见 [node 停机更新与恢复](NODE_UPDATE.md)：先 `mate node stop`，再停止控制面，更换两侧同版产物，启动控制面后才显式 `mate node start`。CLI 一起更换管理程序、专用 Node 与 node，更新后保持停止并保留数据；损坏入口可从校验后的本地包执行同一 CLI 恢复。真实平台验收另记，不恢复部署登记、协调备份、整套数据复制恢复、维护对账或人工释放入口。日常持久化与故障接续继续由运行时负责。数据库格式不匹配或结构缺失时，启动拒绝修改并报告文件与原因；首版不迁移旧实验格式。保留原文件进行排查，或将 `MATE_CONTROL_PLANE_DATA_DIR` 指向新的空目录。
