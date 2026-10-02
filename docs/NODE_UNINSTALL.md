# 卸载 node，保留配置和数据

使用安装 Mate 的同一普通账号执行：

```sh
~/.local/bin/mate node uninstall
```

CLI 先确认本安装单元的归属，停止并禁用 `mate-node.service`，移除它并 reload 用户管理器，然后按完整包库存清理程序。公共入口和活动包最后删除；当前进程已加载的模块及专用 Node 执行映射继续完成清理和报告，最后阶段不再启动辅助程序或读取未加载模块。其余已校验版本包也会清理。外来入口、改写过的单元、未知目录、包内额外或改动过的文件都会明确失败并保留。服务环境 drop-in 是配置，保留在 `~/.config/systemd/user/mate-node.service.d/`，CLI 不删除它。

成功或失败都会列出已完成步骤及保留位置。失败返回非零，不承诺整个卸载完成；修复冲突或权限后，重复同一个命令根据实际文件和用户服务状态继续，不重新安装或启动服务。部分删除的包仍保留 `bundle.json` 到最后，剩余文件必须匹配库存才能继续清理；未知文件不能靠重试强行删除。`~/.local/lib/mate-node/management.lock` 和空目录可以保留；锁 inode 留在原处，避免仍执行中的管理命令与新命令各自取得不同锁。它不是恢复状态登记，重新安装继续使用同一个管理互斥。

卸载不提供 purge 或数据删除选项。以下内容均保留：

- 私有配置：`~/.config/mate/node.json`，包含现有连接配置和可选令牌。
- 节点身份：配置中 `MATE_NODE_DATA_DIR`（默认 `~/.local/share/mate/node`）下的 `node-identity.json`。
- 操作收据与进程数据库：同一数据目录，含 `workspace-receipts` 与节点数据库；卸载不改写这些文件。
- Agent 工作区：配置中 `MATE_NODE_AGENT_WORKSPACE_ROOT`，默认数据目录的 `agents` 子目录。
- 控制面数据库、模型凭据、附件：Compose `.env` 中 `MATE_CONTROL_PLANE_DATA_DIR` 指定的 bind 目录，包含 `control-plane.sqlite` 与 `attachments`。节点 CLI 不管理或探测 Docker，不删除此目录、控制面镜像或 Docker 缓存。

配置损坏、权限不符或数据路径与程序树重叠时，服务清理可以已经完成，但程序删除会拒绝，防止把数据当程序删除；错误输出不包含配置内容。没有可连接的真实用户管理器时也会明确失败；从该账号现有登录会话重试，Mate 不切换系统服务或配置 linger。

## 公共入口已失效时继续同一卸载

保留一个可信的本地完整发布包。下面的 SHA-256 必须来自已校验的构建输出或对应明确版本 Release；此恢复过程只解包和调用原 CLI，不执行 bootstrap/install，不 enable 或 start。示例使用 arm64，x86_64 使用 `linux-x64` 包：

```sh
archive=/absolute/path/mate-node-0.1.0-linux-arm64.tar.gz
printf '%s  %s\n' '<包的64位SHA-256>' "$archive" | sha256sum -c -
recovery=$(mktemp -d)
tar -xzf "$archive" -C "$recovery"
bundle="$recovery/mate-node"
"$bundle/node/bin/node" "$bundle/app/apps/node/dist/management/cli.js" --version
"$bundle/node/bin/node" "$bundle/app/apps/node/dist/management/cli.js" node uninstall
```

版本命令会用这个包自己的专用 Node 校验完整库存和原生依赖。恢复包位于安装程序树之外，卸载不会删除它；操作者完成后自行清理该临时解包目录。之后若要重新安装，按 [完整包](NODE_BUNDLE.md) 和 [用户服务](NODE_SERVICE.md) 步骤执行；已有配置和身份继续使用，不删除身份来重新配对。

控制面容器由所有者在原 Compose 目录清理：

```sh
docker compose --env-file .env -f compose.yaml down
```

这会移除 Compose 容器和网络，bind 数据仍在原宿主目录；不用数据删除开关。节点 CLI 不代替操作者执行 Docker 操作。

## 可重跑的真实服务验收入口

以下脚本只用于已授权、可丢弃的 Linux 宿主/VM 普通测试账号，拒绝已有 Mate 程序或数据和系统 Node。它不创建账号、修改 linger、安装软件或使用提权：

```sh
sh deploy/node/tests/uninstall-smoke.sh \
  /path/mate-node-0.1.0-linux-arm64.tar.gz /path/bootstrap.sh \
  '<SHA-256>' 0.1.0 /path/user-service-peer.mjs
```

脚本使用真实 bootstrap、完整包 CLI 和 systemd 用户管理器，验证外来单元/入口保留、实际 SIGKILL 后公共入口丢失时从本地完整包恢复、重复清理、重新安装原身份和正常自卸载。WebSocket 外部协议服务是合成替身，不是实际控制面/provider。临时目录与用户管理器替身的单元测试另外记录，不能替代上述真实服务证据；四平台矩阵的运行结果由交付验收单独记录。
