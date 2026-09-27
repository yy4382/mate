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

节点重启会把没收尾的操作记成 `unknown`（而非继续算作运行中），这是给所有者复核的已记录未知，不会永久阻止备份；真正会阻止备份的是仍然记作 `started` 的命令。控制面侧仍标为 `executing` 的意图属于对账范围（见下面的跨机恢复），不作为“命令仍在运行”的证据。

```sh
node "$CLI" backup  "$HOME/mate/deploy.json"                     # 默认写入 stateDir/checkpoints/<时间戳>
node "$CLI" backup  "$HOME/mate/deploy.json" "$HOME/backups/mate-1"
node "$CLI" verify  "$HOME/mate/deploy.json" "$HOME/backups/mate-1"
node "$CLI" restore "$HOME/mate/deploy.json" "$HOME/backups/mate-1"
```

用默认目标时 Mate 自己创建 `stateDir/checkpoints`（`0700`）；自己给目标路径时，父目录必须已经存在，否则命令报错，而不是替你在别处造出一串目录。目标路径不存在时 Mate 才会开始复制；状态本身不满足条件（例如还没有节点身份或操作收据）会在停服务之前就报错，不会先停掉一个本来在正常运行的部署。

一份**完成**的备份是这样一个目录：

- `control/`——控制面数据库所在目录，里面有所有者会话（`owner_sessions`）、Agent 逻辑会话与对话记录（`owner_agent_sessions`、`owner_agent_session_journal`）、消息与投递（`owner_messages`、`owner_message_deliveries`）、任务（`owner_tasks`、`owner_task_events`）、提醒（`owner_reminders`、`owner_reminder_firings`）和控制面侧的操作记录（`owner_agent_process_operations`）。
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

恢复后每个本机 Agent 都会被重新核对，未获证实的 Agent 保持暂停。控制面与节点两侧的记录不一致时，`holds` 给出暂停原因，可以对照下表处理（这里是代码会给出的全部原因）：

| `holds` 原因 | 含义 | 处理 |
| --- | --- | --- |
| `operation_result_unproven` | 节点对某个已提交的命令只留下了 `unknown`（例如节点在命令运行期间重启），或者控制面从未收到结果 | 用只读 SQLite 核对两侧收据；结果无法证实时保持暂停，不要手工把 `unknown` 改成成功或失败 |
| `node_receipt_unavailable` | 控制面记录了一个已经有结论的操作，但恢复后的节点收据里没有它 | 核对是不是恢复了两份不同时间的检查点，见下面的“跨机或分开时间的恢复” |
| `node_receipt_stale` | 节点收据比控制面已经确认的版本更旧 | 保持暂停，逐项核对 operation ID、Agent ID、请求哈希与版本 |
| `node_receipt_version_unproven` | 控制面从未记下任何节点收据版本，而这次核对也证明不了结果 | 同上；确认节点是否在命令运行期间重启过 |
| `node_receipt_version_conflict` | 同一操作出现两份同样版本的节点收据 | 保持暂停，逐项核对是哪一份来自本机节点 |
| `node_receipt_version_invalid` | 节点收据缺少可用的版本号，无法判断新旧 | 同上 |
| `operation_result_conflict` | 同一操作在两份记录里的结论不同 | 同上 |
| `operation_identity_conflict` | 控制面意图与节点收据的 Agent、节点或请求身份对不上 | 同上 |
| `operation_node_identity_conflict` | 节点收据声称的操作属于另一个节点 | 同上 |
| `node_operation_without_intent` | 节点手上有一项控制面检查点里没有的操作 | 见下面的“跨机或分开时间的恢复” |
| `node_receipt_identity_unproven` | 节点侧有一条收据无法证明属于哪次请求 | 同上 |
| `control_receipt_identity_unproven` | 控制面侧有一条动作记录无法证明属于哪次请求 | 同上 |
| `node_identity_unproven` | 恢复后的节点身份与控制面配对时保存的公钥不一致 | 不要删除 `node-identity.json`；用原节点身份恢复，或按跨机流程处理 |
| `agent_identity_unproven` | 某个 Agent 的工作区、运行账号或工作区标记与恢复出来的记录不一致 | 确认工作区根路径与运行账号没变，再重新核对 |

`unknown` 结果只按收据保留，**不会**被当成“没执行过”而自动重跑：节点对同一个操作 ID 只会返回它已经记录的结果，不会再次执行那条命令；控制面也不会为被暂停的 Agent 启动新一轮运行。核对函数在 `restore` 里失败时恢复标记会保留，服务保持停止，修复后用 `reconcile` 重新核对，再用 `release-agent` 单独放行某个已证实的 Agent：

```sh
node "$CLI" reconcile     "$HOME/mate/deploy.json"
node "$CLI" release-agent "$HOME/mate/deploy.json" AGENT_UUID
```

`reconcile` 与 `release-agent` 都只做一次重新核对，不会跳过未知结果，也不会把无法证实的收据改成已确认；`release-agent` 对仍然被暂停的 Agent 会以非 0 退出码失败并说明原因。恢复只按原身份恢复到原主机；把备份复制到其他主机、或恢复成不同的工作区路径，都不能直接放行。

多主机（远端节点）不承诺跨机原子检查点：控制面主机上的 `backup` 只覆盖该配置里的本机目录。远端节点主机需要自行在节点停机后备份自己的 `nodeDataDir` 与 `agentHomeRoot`。

### 跨机或分开时间的恢复

远程节点重连的自动对账范围有限：控制面只会向节点查询控制面已知、状态为 `executing` 或 `unknown` 的 `process` / `workspace` 操作 ID；它不会枚举节点收据来发现只存在于较新节点检查点中的额外操作。因此，不同时间点的控制面与远程节点备份恢复后，不能把重连视为两侧完整一致的证明。

节点服务保持停止时，先在控制面网页的 Agent 页面停用受影响的 Agent；无法确定额外收据属于哪个 Agent 时，先停用该节点上的全部 Agent。随后在两侧用只读 SQLite 查看节点身份，以及每项操作的 operation ID、Agent ID、请求身份哈希、状态和收据版本：节点侧查看 `agent_process_operations` 和 `workspace-receipts/*.json`；控制面侧查看 `owner_agent_process_operations` 和 `owner_agent_tool_actions`。逐项核对节点公钥、Agent 的运行账号与工作区标记以及操作身份。发现节点多出操作、任一身份不匹配或结果无法证明时，保持对应 Agent 停用，不要在网页点击“复启 Agent”，也不要运行控制面主机的 `release-agent`；后者只核验部署配置中的本机 `nodeDataDir`，不检查远程磁盘。身份冲突无法定位到单个 Agent，或无法确认节点上所有后台进程已停止时，继续保持该节点服务停止。

第 25 版起 Mate 没有特权命令审批：升级会连同 `owner_privileged_approvals` 一起删除其中的未完成请求，节点上的 `privileged-operations.sqlite` 也不再被读取或对账，两者都不会变成新的持有、收据或重试。升级前若存在未完成的特权命令且需要这些历史证据，请在首次启动第 25 版前用只读 SQLite 自行留存；升级后不要把旧的审批行或节点收据当成仍受支持的状态。

## 升级与回退

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

数据目录格式升级由一个方向进行（例如第 24 版重建单账号 Agent 表，第 25 版删除已废弃的特权审批表）：旧版本读到新格式的数据库不保证可用，回退前先确认检查点与旧发布版本匹配。

## 由宿主管理进程（可选）

Mate 不安装 systemd 单元，也不以 root 运行节点。若希望开机自启或崩溃后重启，由所有者自己写一个**以该普通账号运行**的用户级单元或进程管理器条目，命令就是上面的 `start`。这个条目属于宿主：它由所有者自己创建、自己启用，运行身份是那个普通账号，不使用 root，也不由 Mate 安装或控制。启动脚本由所有者自己维护，内容就是上面的 `start` 命令：

```sh
#!/bin/sh
set -eu
CLI="$HOME/mate/current/dist/src/deployment/cli.js"
exec /usr/bin/env node "$CLI" start "$HOME/mate/deploy.json"
```

Mate 侧不支持也不检测这类宿主条目：它的 `status` 只报告自己启动并记录的进程。因此不要让 `start` 与服务管理器同时启动同一份服务——`start` 在检测到已记录的服务仍在运行时会拒绝，两个互不知情的启动路径则可能各自拉起一个进程。
