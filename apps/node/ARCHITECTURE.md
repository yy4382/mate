# Node（`@palace/node`）

> 总览见 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)。网关一侧见 [packages/gateway/ARCHITECTURE.md](../../packages/gateway/ARCHITECTURE.md)。安装、服务管理和 `palace node` 各命令的行为见 [DEPLOYMENT §3.2](../../docs/DEPLOYMENT.md)。测试见 [TESTS.md](TESTS.md)。

## 职责

node 是一台 Linux、macOS 或 Windows 机器上以宿主现有账号运行的进程，由 `palace node` CLI 管理。它只负责执行：在属于某个 Agent 的工作区里跑命令、读写文件。node 从不接触模型凭据和对话记录，也不判断授权。

## 工作区

文件工具的相对路径以 `<工作区根>/<agentId>` 为根，绝对路径必须在这个目录内。各 node 的文件互相独立，不同步。

主 node（`home`）的工作区在创建 Agent 时由管理模块显式准备，同时创建空的 `MEMORY.md`，已有文件不覆盖。之后执行工具前只检查目录存在，缺失时报错，不重建。获准访问的 node（`visit`）在显式准备和每次执行前都准备工作区，但不创建 `MEMORY.md`，准备失败就不执行工具。浏览工作区只读，不创建目录。runtime 不自动读 `MEMORY.md`，它是 Agent 自己维护的记忆入口。

## 文件工具

`read`、`write`、`edit` 直接用 Durable 自带的工具，跑在限定于工作区的 `NodeExecutionEnv` 上。参数修复和校验、抛错变成错误结果、诊断附在内容后面，都和 Durable 在本地执行时一样。node 没有 Harness，交给工具的调用接口只提供执行环境、输出和诊断，其余成员一被访问就报错，Durable 的文件工具不会访问它们。

## `bash`

node 自己执行 `bash`，不用 Durable 的 `bash` 工具。Durable 的版本把被信号终止折算成 `128+信号`、把非零退出变成抛错、不暴露进程组、不跟踪留下的后台进程，也不标明输出可能不完整，满足不了这里的停止和汇报规则。

- Linux 和 macOS 用 node 账号的 Bash 或 zsh，Windows 用 `powershell.exe -NoProfile -NonInteractive -Command`（PowerShell 5.1）。
- 每条命令一个命令进程组。结果区分正常退出（带退出码）、被信号终止、超时被杀、被停止和没能启动，并标明截断、输出可能不完整，以及 POSIX 上仍在运行的后台进程。
- 工具的名字、说明、参数和时限只在 `@palace/node-protocol` 定义一次。runtime 和 node 用同一个 `parseBashArguments` 解析：runtime 先解析，时限不合法就直接返回错误；合法时转发，node 再解析一次，结果不变。前台命令默认 10 分钟、最多 1 小时，后台命令默认没有时限、最多一天。

## 停止

网关发来停止消息时，node 杀掉这次调用的命令进程组。命令已经返回、只剩后台进程占着输出时收到停止，也杀掉那些后台进程。连接断开时停掉这条连接上所有进行中的调用。node 自己关闭时杀掉它启动的、还有活进程的所有命令进程组。终止失败要报告，并保留句柄供关闭时重试。

Agent 有意脱离进程组的进程（例如 POSIX 上的 `setsid`）由 Agent 自己负责。平台差异由一张表选择：Windows 用 `taskkill /T /F`，只能停仍挂在活 shell 下的进程；macOS 用进程组存活检测，不区分僵尸进程，也不识别 PID 复用。

## 命令目录与启动快照（Linux/macOS）

命令在 node 账号的 Bash 或 zsh 里执行，HOME 是账号主目录，所以 Agent 用的是人在终端里用的同一套 PATH、函数和别名。账号 shell 不是这两者之一时 `bash` 明确失败，不退回 `/bin/sh`。

- **启动快照。** 收到第一个 `bash` 调用时，node 以交互、非登录方式在主目录启动一次账号 shell，把选项、变量、函数和别名经描述符 3 写到数据目录的 `shell-snapshot`。每条命令用新的非交互进程、空环境 `source` 这个文件，再 `eval` 命令。空环境防止 `BASH_ENV`、`ENV` 和导出函数绕过快照。用文件而不用管道，因为 zsh `eval` 一份 200KB 的字符串要近 1 秒，`source` 只要 10ms。捕获最多 30 秒、4 MiB，结果（包括失败）保留到 node 重启，所以一个卡住的 rc 文件不会让每条命令都等 30 秒。改了启动文件要重启 node。
- **命令目录。** node 在内存里按 Agent 和对话记住目录，初始为工作区。对话 ID 由 runtime 从 Durable 取得，不由模型传入。命令正常走完后把 `pwd -P` 写到描述符 3。前台调用把它存为该对话的目录，变化时在结果末尾写明；后台调用从记住的目录开始，但不改它。`exit`、`exec`、信号或超时让 shell 没走到最后时目录不变。记住的目录不在了就从工作区开始，并在结果里说明。重连不清空，重启清空。每个对话各自记目录，所以工作助手的 `cd` 不影响主对话。

Windows 的 PowerShell 不加载 profile，每次都在工作区执行，`HOME`、`PWD` 和 `$HOME` 也是工作区。

## 服务与退出

Linux 用 systemd 用户服务，macOS 用 LaunchAgent，Windows 用当前账号登录时启动的计划任务。身份被拒绝时进程以 78 退出：systemd 用 `RestartPreventExitStatus=78` 停止重启；LaunchAgent 执行 `node run --service`，它把 78 转为 0 并保留日志。Windows 计划任务在 node 崩溃后不保证重启，需要手动 `palace node start`。

`palace node` 的每个命令从现有状态（程序目录、命令、服务定义和服务状态）决定动作，不记录"做到哪一步"。程序目录由暂存目录改名放入、改名挪开再删除，所以要么是完整的某个版本，要么不存在。清单说明哪些文件属于 Palace，有别的文件时 `update` 和 `uninstall` 拒绝。

## 持久化

身份密钥和配置存在 node 本地，和程序目录分开。POSIX 目录和私有文件分别用 0700、0600；Windows 放在当前账号的 `%LOCALAPPDATA%\Palace` 下，依靠默认 ACL 隔离其他普通账号。
