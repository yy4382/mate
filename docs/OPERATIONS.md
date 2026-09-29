# Debian 13 部署与运维（普通账号）

Mate 在低资源 Linux VPS 上以一个**现有普通账号**运行：控制面与节点是同一个账号下的两个普通进程，Agent 命令是该账号的普通子进程。Mate 不创建 Linux 用户、不切换 UID/GID、不安装或控制 systemd 单元，也不修改 sudoers。进程管理与 HTTPS 由宿主自行安排；Mate 提供启动、停止、重启、状态与日志命令。

下文路径里的 `owner` 是那个现有账号，示例目录都在它的 home 下。换账号时替换为你自己的路径。

## 准备

目标机需要 Node.js 24（`.nvmrc` 中的 `24.21.0`）和 pnpm `10.33.0`。**构建与运行在同一个账号下完成**：不需要 root，也不需要 systemd。

```sh
export PATH="$HOME/.n/bin:$PATH"
node --version   # 必须是 v24.x
pnpm install --frozen-lockfile
pnpm build
```

`pnpm build` 生成 `dist/src`（控制面与节点）、`dist/web`（中文网页）。把 `dist`、`node_modules`、`package.json`、`pnpm-lock.yaml` 作为一个发布目录使用——不要把源码、开发数据或私有研究资料放进发布目录。

准备部署配置与初始所有者密码。两者都只属于运行账号：

```sh
install -d -m 0700 "$HOME/mate/state" "$HOME/mate/data"
cp mate.deploy.example.json "$HOME/mate/deploy.json"
$EDITOR "$HOME/mate/deploy.json"
umask 077; cat > "$HOME/mate/owner-password"
chmod 0600 "$HOME/mate/owner-password"
```

部署配置字段（`mate.deploy.example.json` 是模板）：

| 字段 | 含义 |
| --- | --- |
| `publicOrigin` | 所有者在浏览器访问的 HTTPS 原点，例如 `https://mate.example.org`。只用于网页与通知里的链接，Mate 不配置证书。 |
| `controlPlanePort` | 控制面监听端口，只能从本机访问；1024–65535。 |
| `releaseRoot` | 存放发布目录与 `current` 符号链接的目录。 |
| `stateDir` | 存放进程记录、日志与检查点的目录，必须只有运行账号可读。 |
| `controlPlaneDataDir` | 控制面数据库目录。 |
| `nodeDataDir` | 节点身份与操作收据目录。 |
| `agentHomeRoot` | Agent 默认工作区根目录。每个 Agent 在其中有一个以其 UUID 命名的目录。 |
| `ownerPasswordFile` | 初始所有者密码文件，`0600` 普通文件。控制面首次启动后保存 Argon2id 哈希，之后不再需要这个文件（除非从空数据库恢复）。 |

密码至少 12 字节。配置里的路径必须互不相同、都是绝对路径，数据目录不能放在 `releaseRoot` 内。

## 安装与启动

安装把发布目录登记到 `releaseRoot/releases/<内容摘要>`，把 `current` 指向它，并启动控制面：

```sh
node dist/src/deployment/cli.js install "$HOME/mate/deploy.json" "$PWD"
```

安装**只启动控制面**：新节点需要所有者在网页生成的一次性配对令牌，所以安装命令会输出下一步提示，而不是猜一个令牌。登录网页生成令牌后启动两个服务：

```sh
CLI="$HOME/mate/current/dist/src/deployment/cli.js"
umask 077; set -a; printf 'MATE_NODE_PAIRING_TOKEN=%s\n' '网页生成的令牌' > "$HOME/mate/node.env"; . "$HOME/mate/node.env"; set +a
node "$CLI" start "$HOME/mate/deploy.json"
```

服务以普通子进程启动，输出写入 `stateDir/<服务名>.log`，进程记录写入 `stateDir/<服务名>.json`。启动命令等到控制面打印监听端口并真的回答本机 `/api/status`、节点完成认证才返回；任一步失败都会把失败原因和该服务最后的输出一起报出来，并停掉半启动的进程。

日常命令：

```sh
CLI="$HOME/mate/current/dist/src/deployment/cli.js"
node "$CLI" start   "$HOME/mate/deploy.json"                     # 启动两者；已在运行的按现状报告
node "$CLI" stop    "$HOME/mate/deploy.json"                     # 停止两者
node "$CLI" stop    "$HOME/mate/deploy.json" node                # 只停节点（或 control-plane）
node "$CLI" restart "$HOME/mate/deploy.json"                     # 重启两者
node "$CLI" restart "$HOME/mate/deploy.json" control-plane       # 只重启控制面
node "$CLI" status  "$HOME/mate/deploy.json"                     # 状态（JSON）
node "$CLI" doctor  "$HOME/mate/deploy.json"                     # 状态 + 本机控制面 HTTP 探测
node "$CLI" logs    "$HOME/mate/deploy.json"                     # 两个服务的最新日志
```

`stop` 与 `restart` 的停止未获确认时不会假称已停：报告会给出仍在运行的进程号，`restart` 也不会在这种情况下重新启动。停止节点时，节点会先结束它启动过的普通命令进程组，因此命令不会在节点退出后无人跟踪地继续跑；无法确认结束的命令会写进节点输出与操作收据，供后续核对。被 `SIGKILL` 强杀、没来得及做这一步的节点也不会因此显得干净：那项服务的停止报告会带上 `unconfirmedCommands`（写明未能确认结束的命令数，数量未知时为 `"unknown"`）。备份与升级在同一账号下运行，它们的停止步骤会对无法确认停止的服务、以及无法确认结束的命令直接报错，而不是在服务仍在运行时创建检查点。**Mate 不负责开机自启或崩溃重启**：需要这些就由宿主自行配置（见下）。

## 首次使用

1. 在宿主的 HTTPS 反向代理里把 `publicOrigin` 指向 `http://127.0.0.1:<controlPlanePort>`（Caddy 示例：`reverse_proxy 127.0.0.1:8787`）。证书、域名和 80/443 端口都由宿主负责。
2. 浏览器打开 `publicOrigin`，用初始密码登录。
3. 在“节点管理”生成一次性配对令牌，按上面的 `start` 示例用它启动节点。
4. 配对成功后节点把身份保存在 `nodeDataDir/node-identity.json`，之后启动不再需要令牌；这时可以从环境文件里删掉 `MATE_NODE_PAIRING_TOKEN`。网页显示节点在线后创建 Agent：工作区由节点在该账号下建立，网页会显示工作区路径与运行账号。

## 断线与失败诊断

控制面与节点各自独立，诊断也分开：

- `doctor` 输出每个服务的真实状态：`running` / `exited` / `not_running`，进程号，以及 `controlPlaneHttp`。`controlPlaneHttp: running` 才说明本机控制面真的在回答 `/api/status`。
- `logs` 打印两个服务最新输出。重启服务会截断该服务的日志，所以它看到的是本次运行的输出。
- 节点是否**真的在线**由控制面网页显示：网页的节点状态来自控制面的认证会话，`status` 只看本机进程，两者不能互相冒充。
- 节点断线时先看 `logs`：`Node WebSocket disconnected; reconnecting.` 与 `Node WebSocket connection failed; retrying.` 表示节点进程活着但没连上控制面。再检查 `MATE_CONTROL_PLANE_URL`、控制面端口和宿主反向代理；`配对令牌无效、已过期或已使用。` 表示令牌已被用过或过期，需要重新生成。
- 节点身份不匹配时控制面会拒绝：`控制面拒绝了此节点身份。` 不要删除或重建 `node-identity.json` 来“修复”断线——那会让已创建的 Agent 失去原身份，只能按下面的恢复流程处理。
- 节点退出时会先结束它启动过的普通命令进程组，避免命令在无人跟踪的情况下继续运行；结果写入节点输出与操作收据。宿主的 `sudo` 派生的 root 后代不在其中：普通账号能否结束它们由宿主配置决定，Mate 不对此作任何声明。

## 备份与恢复

`backup` 只用运行账号自己的权限——不需要 root、systemctl 或任何特权审批。它先检查这份状态本身是否具备生成完整备份的条件，再停两个服务并要求停稳得到确认，然后复制控制面数据库、节点身份与操作收据、以及 Agent 工作区，最后恢复原来的服务状态。服务停不下来、停下来却报告有命令无法确认结束，或者节点操作收据里还留着已开始但未结算的命令（这些命令的进程组可能在节点退出后继续写工作区），都会让 `backup` 直接失败，而不是在可能有东西仍在写入时生成检查点。同一份部署同一时刻只允许一个会改动它的命令（备份、恢复、对账、升级、启停共用 `stateDir/maintenance.lock`），第二个会直接报锁被占用，而不是复制另一个步骤已经恢复服务后的状态。**只有会复制状态的步骤（`backup`、`upgrade`）受“未结算命令”这一条约束**：`reconcile`、`release-agent` 和 `restore` 正是用来处理无法确认的结果的，它们不会被这条规则挡住。

节点重启会把没收尾的操作记成 `unknown`（而非继续算作运行中），这是保留给 Agent 决策的已记录未知，不会永久阻止备份；真正会阻止备份的是仍然记作 `started` 的命令。控制面侧仍标为 `executing` 的意图属于对账范围（见下面的跨机恢复），不作为“命令仍在运行”的证据。

```sh
node "$CLI" backup  "$HOME/mate/deploy.json"                     # 默认写入 stateDir/checkpoints/<时间戳>
node "$CLI" backup  "$HOME/mate/deploy.json" "$HOME/backups/mate-1"
node "$CLI" verify  "$HOME/mate/deploy.json" "$HOME/backups/mate-1"
node "$CLI" restore "$HOME/mate/deploy.json" "$HOME/backups/mate-1"
```

用默认目标时 Mate 自己创建 `stateDir/checkpoints`（`0700`）；自己给目标路径时，父目录必须已经存在，否则命令报错，而不是替你在别处造出一串目录。目标路径不存在时 Mate 才会开始复制；状态本身不满足条件（例如还没有节点身份或操作收据）会在停服务之前就报错，不会先停掉一个本来在正常运行的部署。

一份**完成**的备份是这样一个目录：

- `control/`——控制面数据库所在目录，里面有所有者会话（`owner_sessions`）、Agent 逻辑会话与对话记录（`owner_agent_sessions`、`owner_agent_session_records`）、消息与投递（`owner_messages`、`owner_message_deliveries`）、任务（`owner_tasks`、`owner_task_events`）、提醒（`owner_reminders`、`owner_reminder_firings`）和控制面侧的操作记录（`owner_agent_process_operations`）。
- `node/`——节点身份 `node-identity.json`、节点操作收据数据库 `agent-process-operations.sqlite` 与工作区收据目录 `workspace-receipts/`。
- `homes/`——每个 Agent 的默认工作区，按 Agent UUID 分目录。
- `manifest.json`——上述每个条目的路径、类型、权限、属主和内容哈希。
- `complete.json`——清单的校验和。它最后写入，只有它存在才说明这份备份复制完整并通过了自检。

`verify` 证明的是这份备份现在仍然等于它被写下时的样子：目录只有运行账号可读，根条目只能有上面这五个，`complete.json` 里的校验和与 `manifest.json` 一致，清单里每个条目的类型、权限、属主和内容哈希都与磁盘相符，两个 SQLite 文件能打开且 `PRAGMA integrity_check` 通过，控制面数据库里上面那些表都在且能读，节点身份仍是可用的 Ed25519 私钥。校验只读：它不修改备份，也不“修复”失败的结果；不通过就以非 0 退出码结束并说明原因。

备份中断、某个路径读不了、或任何一步失败时，Mate 都不写 `complete.json`，并明确说明剩下的东西“不是备份”；对这样的目录运行 `verify` 会报“不完整”。已经复制出来的部分会留在原处供你查看，但不会被当成可恢复的备份——确认无用后删掉它再重试。

### 恢复

恢复一共三步，全部用运行账号自己的权限：先停两个服务，再对同一份检查点做一次 `verify`，确认无误后 `restore`，最后按需要 `start`：

```sh
node "$CLI" stop    "$HOME/mate/deploy.json"
node "$CLI" verify  "$HOME/mate/deploy.json" "$HOME/mate/backups/mate-1"
node "$CLI" restore "$HOME/mate/deploy.json" "$HOME/mate/backups/mate-1"
node "$CLI" start   "$HOME/mate/deploy.json"
```

`restore` 不假设服务已经停：它在改动任何东西之前先停掉当时在运行的服务、并要求停稳得到确认，而且只有在检查点先通过 `verify` 之后才会替换 `control/`、`node/`、`homes/` 这三份状态。由此得到的三条行为：

- 检查点缺少 `complete.json`、内容在写入之后被改过、或那个路径根本不是检查点时，`restore` 以非 0 退出码失败，不打印任何恢复报告，不停任何服务，也不改动任何现有状态。**损坏或不完整的备份不会产生“恢复成功”的结果**，被拒绝的检查点本身也不会被改动或“修复”，换一份或重新备份后仍可使用。
- 替换状态之前会先写 `control/` 与 `node/` 旁边的 `recovery-in-progress` 标记，并在恢复完成后重新核对每个 Agent 的身份与操作收据；核对成功之前这些标记一直在，存在时任何服务启动与任何新的检查点都会拒绝。核对失败时标记保留、服务保持停止。
- 恢复前确实在运行的服务会由 `restore` 重新启动；本来就停着的服务不会被它启动，恢复完由所有者自己运行 `start`。三个数据目录必须已经存在且是真实目录（`controlPlaneDataDir` 由控制面启动时创建，`nodeDataDir` 由节点启动时创建，`agentHomeRoot` 在节点为第一个 Agent 准备工作区时创建）；任何一个缺失或不是真实目录时，`restore` 以 `Restore destination must be a real directory: <路径>` 失败，而不是替你在别处新建目录——这一条和检查点自身的拒绝一样，在任何服务被停掉之前就报错。因此在恢复到一台从没有过这份部署的主机之前，要先让两个服务按部署配置把这三个目录建出来。

恢复的输出写明它用的是哪份检查点（`checkpoint` 路径与 `id`）、核对了多少条收据（`checkedOperations`）、哪些收据被这次核对改写（`confirmed`）、哪些 Agent 仍被暂停及原因（`holds`）、哪些已经放行（`released`）、被替换掉的旧状态放在哪里（`previous`），以及两个服务现在的状态（`services`）。

`previous` 里的目录形如 `<数据目录>.mate-before-<检查点 id>`，是被 `restore` 整体移到一边的恢复前状态。因此**恢复是回到检查点那一刻**：检查点之后产生的会话、消息、任务和命令收据不会回到线上，但也不会被删掉——包括只存在于恢复前状态里的操作收据（`agent-process-operations.sqlite` 与 `workspace-receipts/`）都还能用只读 SQLite 查看，核对完确认无用后由你自己删除。

### 恢复后核对未完成的命令

恢复会核对原 Agent 身份、同一会话和执行环境。它们可用时，历史未知、缺失、冲突或部分无法解析的信息不会暂停整个 Agent：无需所有者复核或确认，原待处理输入没有新消息也会自动续接。下一次模型决策前，Mate 把可恢复的操作身份、请求摘要、未知原因持久提供给同一会话，包括旧命令仍可能运行的事实。Agent 自行选择检查、补救或继续；重复恢复不会重复追加相同事实，有效迟到收据会作为新事实追加。

`unknown` 结果只按收据保留，**不会**被当成“没执行过”而自动重跑；恢复程序不重放已经执行或结果未知的操作，也不改变旧 run 已结束的事实。Agent 知情后仍可通过正常工具发起新操作。Agent 已继续工作不代表历史命令已经停止，一致备份的停服与未结算命令检查保持有效。

历史证据的说明包括：`operation_result_unproven`（结果未知）、`node_receipt_unavailable`（收据缺失）、`node_receipt_stale`（节点版本较旧）、`node_receipt_version_unproven`（版本无法核实）、`node_receipt_version_conflict`（重复版本冲突）、`node_receipt_version_invalid`（版本无效）、`operation_result_conflict`（结果冲突）、`operation_identity_conflict`（历史操作归属或请求不匹配）、`node_operation_without_intent`（只有节点留下记录）、`node_receipt_identity_unproven` 和 `control_receipt_identity_unproven`（历史信息不能完整解析或核实）。这些是提供给 Agent 的未知事实，不是全局暂停原因，也不会被当作可信成功结果。

`holds` 只保留实际不可用的身份或环境：`node_identity_unproven` 表示节点配对公钥无法核实；`agent_identity_unproven` 表示原账号、工作区或标记不匹配；`agent_session_unavailable` 表示原会话记录缺失，需要从同一份原数据恢复。不要删除节点身份或换一条会话来绕过问题；恢复原身份和工作区后，用下列维护入口重新核验。每次仍先停服务、核对、再启动；修复后可自动释放恢复保护，所有者主动设置的暂停仍有效。

```sh
node "$CLI" reconcile     "$HOME/mate/deploy.json"
node "$CLI" release-agent "$HOME/mate/deploy.json" AGENT_UUID
```

`release-agent` 对身份或环境仍不可用的 Agent 会以非 0 退出码失败并说明原因。若 `restore` 核对本身失败，恢复标记保留，服务保持停止，修复后用 `reconcile` 重试。维护不会把未知结果改成已确认，也不解除人工暂停。恢复只按原身份恢复到原主机；把备份复制到其他主机、或恢复成不同的工作区路径，都不能直接放行。

多主机（远端节点）不承诺跨机原子检查点：控制面主机上的 `backup` 只覆盖该配置里的本机目录。远端节点主机需要自行在节点停机后备份自己的 `nodeDataDir` 与 `agentHomeRoot`。

### 跨机或分开时间的恢复

远程节点重连的自动对账范围有限：控制面只会向节点查询控制面已知、状态为 `executing` 或 `unknown` 的 `process` / `workspace` 操作 ID；它不会枚举节点收据来发现只存在于较新节点检查点中的额外操作。因此，不同时间点的控制面与远程节点备份恢复后，不能把重连视为两侧完整一致的证明。

分开时间恢复时，先停服务，在两侧核对原节点身份、运行账号、工作区标记和同一会话，再启动。控制面主机的 `release-agent` 只核验配置中的本机 `nodeDataDir`，不能代替远程磁盘核验。实际身份或环境冲突无法定位到单个 Agent 时，保持受影响节点停止，恢复原目录和身份后重新核验。历史操作结果未知或收据冲突则保留为未知并允许自动续接，无需逐条人类放行；远端只存在于较新节点检查点的额外收据仍需在原节点只读查看，不能声称在线有限查询已发现它们。所有者已有的人工暂停保持有效；需要时在网页明确复启。

## 升级与回退

以下发布升级流程适用于使用同一数据格式的版本。本格式不升级旧实验数据库；启动遇到旧格式时会拒绝修改，请保留旧目录并改用新的空数据目录。

升级作为一套版本进行。`upgrade` 会先停掉正在运行的服务并确认停稳，再创建协调检查点，只有在检查点成功后才会登记并启用新发布目录：

```sh
node "$CLI" upgrade "$HOME/mate/deploy.json" /ABSOLUTE/new-release
node "$CLI" status  "$HOME/mate/deploy.json"
```

输出包含 `release`、`checkpoint` 与检查点路径。服务在升级期间保持停止；升级完成后由同一条命令把停过的服务重新启动。若新版本启动失败，`upgrade` 会报错并给出检查点路径；此时 `current` 已经指向新版本，所以回退必须按顺序显式执行——先停掉仍在运行的服务，再把 `current` 指回旧发布目录，最后用检查点恢复数据并启动：

```sh
CLI_OLD=/ABSOLUTE/old-release/dist/src/deployment/cli.js
node "$CLI" stop "$HOME/mate/deploy.json"
node "$CLI_OLD" install "$HOME/mate/deploy.json" /ABSOLUTE/old-release
node "$CLI_OLD" restore "$HOME/mate/deploy.json" "$HOME/mate/state/checkpoints/<检查点>"
node "$CLI_OLD" start "$HOME/mate/deploy.json"
```

`install` 对已在运行的服务按现状报告而不是拒绝，因此重复执行这条回退路径是安全的；`restore` 会在恢复后重新核对身份并启动当时正在运行的服务。数据没有被新版本改写过时，可以跳过 `restore` 直接启动旧版本。

回退前确认检查点与旧发布版本的数据格式匹配；不要用旧版本打开不兼容的数据目录。

## 由宿主管理进程（可选）

Mate 不安装 systemd 单元，也不以 root 运行节点。若希望开机自启或崩溃后重启，由所有者自己写一个**以该普通账号运行**的用户级单元或进程管理器条目，命令就是上面的 `start`。这个条目属于宿主：它由所有者自己创建、自己启用，运行身份是那个普通账号，不使用 root，也不由 Mate 安装或控制。启动脚本由所有者自己维护，内容就是上面的 `start` 命令：

```sh
#!/bin/sh
set -eu
CLI="$HOME/mate/current/dist/src/deployment/cli.js"
exec /usr/bin/env node "$CLI" start "$HOME/mate/deploy.json"
```

Mate 侧不支持也不检测这类宿主条目：它的 `status` 只报告自己启动并记录的进程。因此不要让 `start` 与服务管理器同时启动同一份服务——`start` 在检测到已记录的服务仍在运行时会拒绝，两个互不知情的启动路径则可能各自拉起一个进程。

### Agent 上下文持久化

控制面 SQLite 的 `owner_agent_session_records` 是每名 Agent 模型历史的唯一持久来源。完整 Pi 消息按实际呈现顺序追加，包含工具调用与结果、思考签名和供应商用量；频道、讨论串、私信和重启共用该记录。运行中新消息提示也进入历史，但不代表正文已读。每轮运行记录固定的模型、系统提示、工具定义和 Pi 版本；配置修改从下一轮采用。

工具调用和结果分别获得 SQLite 提交确认后，才执行工具和继续模型请求。操作收据独立确定副作用是否发生；后来核对得到的结果作为新信息追加，不覆盖模型当时看到的未知结果。协调恢复检查点包含完整历史和待呈现的收据更正。

旧文本历史、快照和主动 `session.compact` 工具已经移除。模型上下文接近容量时，运行中的模型进程单独请求摘要，控制面确认摘要和保留起点后，下一次普通请求才从检查点继续；SQLite 仍保留原始完整记录。摘要失败或无法合法切分时，原记录保持不变；连续失败两次会以“上下文压缩待处理”暂停该 Agent，所有者可在网页动态中展开具体失败原因，检查模型容量或摘要响应后重试。累计用量不触发停工。
