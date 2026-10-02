# Linux 运行与运维（普通账号）

已确认的首版运行路径是控制面镜像/Compose 与普通账号 node 完整包、薄 bootstrap、统一 `mate node` CLI 及用户服务，见 [ADR-0009](adr/0009-lightweight-linux-packaging.md)；控制面镜像与 Compose 的唯一部署入口见[控制面部署](CONTROL_PLANE_DEPLOYMENT.md)。node 完整包仍待实现与真实用户服务验收；下文源码入口仅用于开发与测试，不能视为 node 安装包/systemd 操作手册。

当前控制面在自身进程内异步推进 Agent 模型循环，节点在同一现有普通账号下启动普通命令子进程。Mate 不创建用户、不切换 UID/GID、不为命令创建 systemd 单元，也不修改 sudoers。HTTPS 代理由宿主配置；目标中的薄 bootstrap 只安装 CLI，CLI 管理 node 用户服务，linger 仍须由用户明确自行配置。

## 构建与准备

使用 Node.js `24.21.0` 与 pnpm `10.33.0`，以运行 Mate 的普通账号执行：

```sh
pnpm install --frozen-lockfile
pnpm build
```

构建生成 `apps/control-plane/dist/main.js`、`apps/node/dist/main.js` 和 `apps/web/dist`。运行时保留四个 package 的 `package.json`、构建结果和安装好的依赖：`apps/control-plane`、`apps/node`、`apps/web`、`packages/protocol`。web 还须保留导出文件 `assets.mjs`，控制面通过它定位该 package 的 `dist`；workspace 链接须指向交付目录内的 package。数据目录放在构建输出之外。

若要把构建结果移到源码之外，先在新目录按相同相对位置准备上述 package 文件，并保留根 `package.json`、`pnpm-workspace.yaml` 和 `pnpm-lock.yaml`，再运行 `pnpm install --prod --frozen-lockfile`，不要复制指向原 checkout 的 `node_modules` 符号链接。入口、网页和节点辅助程序均按 package 自己的位置解析，可从任意工作目录运行绝对入口路径。这个目录是普通构建交付内容，Mate 不提供发布或进程管理器。

准备仅自己可读的初始密码文件，内容为 12–1024 UTF-8 字节。以下路径是同一账号的示例，可替换为自己的绝对路径：

```sh
install -d -m 0700 "$HOME/mate/data"
umask 077
cat > "$HOME/mate/owner-password"
chmod 0600 "$HOME/mate/owner-password"
```

## 直接启动

在第一个终端、构建所在目录启动控制面：

```sh
MATE_CONTROL_PLANE_DATA_DIR="$HOME/mate/data/control-plane" \
MATE_OWNER_PASSWORD_FILE="$HOME/mate/owner-password" \
MATE_CONTROL_PLANE_PORT=8787 \
MATE_PUBLIC_ORIGIN=https://mate.example.org \
node apps/control-plane/dist/main.js
```

出现 `MATE_CONTROL_PLANE_LISTENING 8787` 后，可用 `curl http://127.0.0.1:8787/api/status` 检查控制面是否回答。它只监听本机；宿主的 HTTPS 反向代理把公开原点转到 `127.0.0.1:8787`。域名、证书与公开端口由宿主配置。浏览器打开公开原点，用初始密码登录，在“节点管理”生成一次性配对令牌。

在第二个终端以同一账号启动节点：

```sh
MATE_CONTROL_PLANE_URL=http://127.0.0.1:8787 \
MATE_NODE_DATA_DIR="$HOME/mate/data/node" \
MATE_NODE_AGENT_WORKSPACE_ROOT="$HOME/mate/agents" \
MATE_NODE_PAIRING_TOKEN='网页生成的令牌' \
node apps/node/dist/main.js
```

节点输出 `MATE_NODE_PAIRED` 和 `MATE_NODE_CONNECTED` 后，网页显示在线，可创建 Agent、设置模型服务 API key 并开始交流。配对身份保存在节点数据目录的 `node-identity.json`；以后用原路径启动，省略 `MATE_NODE_PAIRING_TOKEN`。模型凭据在网页管理，仅控制面保存并用于模型请求，不下发节点，不放在启动配置里。所有环境变量见[运行配置](CONFIGURATION.md)。

远程 Linux 节点使用同样的构建入口和本机数据路径，将 `MATE_CONTROL_PLANE_URL` 设置为控制面的 HTTPS 原点，使用网页配对令牌。跨机部署不是首版验收范围。

## 记录与查看任务

在时间线消息的操作菜单、讨论串根消息或回复的操作菜单选择“从消息建任务”，编辑预填的标题后点击“创建任务”即可提交。标题去掉两端空白后须为 1 至 200 字符；同一消息可以继续添加其它任务，回复任务始终挂在所选回复上。消息旁显示全部任务的标题、负责人和状态，“任务看板”保留每项任务及原消息链接。发送时勾选“作为任务发送”只附带一个以消息正文为默认标题的任务。

Agent 用 `tasks.create` 指定原消息与标题建立待认领任务，再用 `tasks.claim` 明确任务 ID 和看到的版本认领。创建返回 `tasks_changed` 时包含当前全部关联任务及 `taskSnapshot` 标记；Agent 可以认领已有任务、协调、放弃，或原样带回标记为另一事项创建。成功创建返回新任务及更新标记。正文变化仍通过现有任务草稿选择处理，更新任务标记不修改草稿中的标题或消息锚点。已完成的调用在同一会话中按操作 ID 返回持久结果。

## 停止、重启与诊断

在前台终端按 Ctrl-C，或由宿主向相应进程发送 SIGTERM。重启时重新执行上述启动命令，并沿用原数据路径；不要删除节点身份或新建会话来绕过错误。节点在正常退出时尽力结束自己跟踪的普通命令进程组，无法确认结束的命令如实写入输出与收据。普通账号能否终止由 `sudo` 派生的 root 后代取决于宿主权限。

控制面是否回答可从 `/api/status` 检查，节点是否完成认证则看网页和 `MATE_NODE_CONNECTED`。两个进程的标准输出、标准错误由启动终端或宿主保存，当前源码尚不提供服务状态、日志或启停 CLI；目标中的统一 `mate node` 命令尚待实现，不能用这些源码步骤代替 CLI 验收。

- `Node WebSocket disconnected; reconnecting.` 或 `Node WebSocket connection failed; retrying.` 表示节点仍在尝试连接；检查控制面进程、URL、端口和反向代理。
- 配对令牌无效、过期或已使用时，在网页重新生成令牌。已配对节点使用保存的原身份认证，不应靠删除 `node-identity.json` 排查连接问题。
- 每次运行开始前都通过原节点核验账号、工作区路径和标记；缺失或改变时保留输入队列并退避重试，不重建工作区。修复原数据后自动接续；网页停用后的恢复也使用同一核验，不能用新身份替代。
- 临时模型服务失败自动退避；人工暂停、凭据错误和上下文压缩失败在网页显示原因，按实际原因修复。历史操作结果未知仍是未知，不因 Agent 继续工作而改成成功。

## 数据与日常接续

控制面 SQLite 是共享事实和每名 Agent 模型历史的唯一持久来源。完整消息按实际呈现顺序追加，包含工具调用、结果、运行中新消息提示和供应商用量。频道、讨论串、私信与重启共用同一逻辑会话。工具调用和结果分别获得控制面持久确认后，才执行工具和继续模型请求。

节点保存身份、工作区和操作收据。断连使旧 run 失去提交资格；重连与进程重启从控制面已确认的原会话继续，并按操作 ID 核对收据。无法确认的副作用作为新事实提供给 Agent，由它选择检查、补救或继续；运行时不自动重放未知操作，也不解除人工暂停。

模型上下文接近容量时，运行进程请求摘要，控制面确认摘要与保留起点后才采用压缩上下文；原始完整历史仍保留。摘要连续失败或无法合法切分时，网页动态提供具体失败原因，所有者修复后重试。累计 token 或费用不触发停工。

当前源码尚无轻量安装/升级产物；目标按 [ADR-0009](adr/0009-lightweight-linux-packaging.md) 提供由 CLI 执行的手动同版本整包更换（包括 CLI 与专用 Node），node 停止后更新且保持停止，保留数据而不恢复部署登记、协调备份、整套数据复制恢复、维护对账或人工释放入口。日常运行持久化与故障接续继续由运行时负责。数据库格式不匹配或结构缺失时，启动拒绝修改并报告文件与原因；首版不迁移旧实验格式。保留原文件进行排查，或将 `MATE_CONTROL_PLANE_DATA_DIR` 指向新的空目录。
