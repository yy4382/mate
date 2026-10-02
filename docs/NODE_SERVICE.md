# 用 mate node 管理当前账号的用户服务

先按 [完整包说明](NODE_BUNDLE.md) 用薄 bootstrap 安装明确版本的管理入口。以下命令均使用当前普通账号，绝对 CLI 路径为 `~/.local/bin/mate`。Mate 不创建账号、不切换身份、不安装系统软件，也不配置 sudo、Docker 权限或 linger。

## 首次配置与安装

安装服务前，在 Mate 网页生成节点配对令牌。用当前账号创建私有配置目录和文件，把 URL 与令牌写入文件，令牌不作为命令参数。示例中的占位符需要替换为网页令牌：

```sh
mkdir -p ~/.config/mate
chmod 700 ~/.config/mate
umask 077
cat > ~/.config/mate/node.json <<'JSON'
{
  "MATE_CONTROL_PLANE_URL": "http://127.0.0.1:8787",
  "MATE_NODE_PAIRING_TOKEN": "<网页生成的一次性配对令牌>"
}
JSON
chmod 600 ~/.config/mate/node.json
~/.local/bin/mate node install
```

配置使用已有环境变量名作为 JSON 字段。可选 `MATE_NODE_DATA_DIR` 与 `MATE_NODE_AGENT_WORKSPACE_ROOT` 必须是账号可写的绝对目录，默认分别为 `~/.local/share/mate/node` 和其 `agents` 子目录。数据与工作区不能位于 Mate 的程序、配置、单元或管理入口目录中，也不能包含这些目录；这样程序维护不会把数据当成程序删除。数据目录保持 0700。已有配置不会被默认值覆盖；缺配置时 `install` 只生成不含令牌的私有默认文件，首次启动前仍要求填写令牌。配置无效或权限不符会明确失败，不输出配置内容。

程序目录是 `~/.local/lib/mate-node/versions/<版本>`；唯一单元是 `~/.config/systemd/user/mate-node.service`。单元直接以包内专用 Node 的绝对路径运行 node 入口，用非秘密的 `--config-file` 绝对路径参数指向上述配置文件（该参数优先于服务环境）；令牌仍不进入单元正文或 argv。专用运行时不加入系统 PATH。服务不会加载交互 shell 的启动文件，所需宿主工具应在用户服务环境中配置；自定义服务环境放在 systemd drop-in，不要改写 Mate 生成的单元正文。Mate 不为 Agent 普通子进程创建额外单元或 scope。

首次创建单元后执行用户级 reload、enable、start。重复安装不会重启运行中的进程，也不会重新启用或启动已经 disabled/停止的单元。若安装在单元创建后中断，重试会根据现有单元完成 reload，保留停止或禁用事实；随后由所有者明确 `mate node start`。已存在另一版本或非 Mate 同名单元会拒绝覆盖。

服务进程启动成功不等于配对或在线。网页与 `mate node logs` 显示握手事实。已有身份先认证；控制面不认识此身份时才使用文件中的令牌。若令牌被拒绝，保留 `node-identity.json`，在同一配置文件换新令牌，再执行 `mate node restart`。不要删除身份来排查。网页确认配对成功后，移除配置中的 `MATE_NODE_PAIRING_TOKEN` 字段，后续沿用原身份。

## 启停、状态与 journal

```sh
~/.local/bin/mate node start
~/.local/bin/mate node stop
~/.local/bin/mate node restart
~/.local/bin/mate node status
~/.local/bin/mate node logs --lines 100
~/.local/bin/mate node logs --lines 200 --follow
```

CLI 使用完整包内的 D-Bus 库短暂连接 systemd 已有的私有 socket，读取带类型和参数数组的命令属性（无须单独的 session bus 或额外系统软件），并核对有效执行命令、关闭环境变量展开的标志及配置路径。drop-in 改写这些引用会明确拒绝启动并报告，避免状态假报；stop 与 logs 只要求基本 manager 状态和 Mate 单元归属，错误引用或属性检查不可用时仍可停止和诊断。正常自定义宿主工具环境可继续使用 Environment/EnvironmentFile。

状态显示完整包版本、单元/配置/数据/工作区路径、URL，以及真实 user manager 的 Loaded、Enabled、Active、PID 和 linger。缺 manager、缺单元、缺配置、损坏配置或版本引用不一致返回非零，不能表示正常停止。失败操作返回非零并指向状态和 journal；文件已经写入不表示服务操作成功。日志直接读取用户 journal，不建立额外日志存储；journal 的宿主保留策略由运行者设置。

异常退出采用 systemd 的 `Restart=on-failure` 和 5 秒重试；显式 stop 保持停止。正常停止先让 node 按既有收据逻辑结束命令；超过 45 秒的停止由 systemd 清理此服务剩余进程。管理变更使用本机短暂文件锁，冲突命令明确失败，锁随进程退出释放；不持久化安装意图或另建维护数据库。

enable 只把单元挂到该账号 user manager 的启动目标。它不启动开机时的 user manager，也不承诺注销后仍运行；这些由用户自行决定和配置 linger。Mate 只读取 `loginctl` 的当前事实，不调用 enable-linger 或 sudo。缺可用 user manager 时 `mate node install` 明确失败；不退回裸后台进程或系统服务，薄 bootstrap 和版本命令仍可用。原始 `systemctl --user`/`journalctl --user` 可用于宿主诊断，例如检查人为 disabled 的选择，但日常管理使用上述 CLI。

## 独立真实服务验收

在明确授权的可丢弃 Linux 宿主或 VM、现有普通账号、实际 user manager 中运行；账号不能已有 Mate 程序、单元、配置或数据，PATH 中不能有系统 Node。测试不会配置账号、linger、权限提升或系统软件。

```sh
sh deploy/node/tests/user-service-smoke.sh \
  /path/mate-node-0.1.0-linux-arm64.tar.gz /path/bootstrap.sh \
  '<SHA-256>' 0.1.0 /path/user-service-peer.mjs
```

此脚本执行实际 bootstrap、包内 CLI、用户服务和 journal；外部 WebSocket 测试服务明确是合成协议接缝，验证拒绝令牌后保留身份换令牌、身份优先、服务重复安装/停止/禁用/重启/异常恢复、日志、缺 manager、配置与单元冲突。它不证明真实控制面、真实 provider、四平台矩阵或 linger 注销/开机行为；这些分别记录正式验收证据。容器或 macOS 的边界测试也不能替代此脚本的真实用户服务证据。脚本保留配置和数据，并在结束时停止服务；测试环境由操作者关闭。
