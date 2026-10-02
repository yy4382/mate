# 手动停机更换同版控制面与 node 完整包

所有者选择明确的兼容发布版本，CLI、专用 Node 和 node 一起更换，不能分别选版本。CLI 不停止控制面、不代替所有者停机、不启动更新后的 node，也不迁移数据库或自动回滚。没有 `latest`、自动更新服务或任意历史格式兼容承诺。

维护顺序是 `mate node stop` → 控制面 stop → 更换两侧同一版本 → 控制面 start → `mate node start`。例如在保存交付 `compose.yaml` 与私有 `.env` 的目录，以现有普通账号操作：

```sh
~/.local/bin/mate node stop
docker compose --env-file .env -f compose.yaml stop

# 获取可信完整包及其 SHA-256；用实际文件和对应校验值替换占位符。
~/.local/bin/mate node update --version 0.2.0 \
  --package /path/mate-node-0.2.0-linux-arm64.tar.gz \
  --sha256 '<对应包的64位SHA-256>'

# 把现有 .env 中的 MATE_CONTROL_PLANE_IMAGE 改为相同 0.2.0 版本的镜像。
# 沿用原 UID/GID、私有 bind 数据目录和原配置，不重新初始化所有者密码。
docker compose --env-file .env -f compose.yaml create --force-recreate
docker compose --env-file .env -f compose.yaml start
~/.local/bin/mate node start
~/.local/bin/mate node status
~/.local/bin/mate node logs --lines 100
```

已有 `gh` 时，也可由当前命令的临时 `GH_TOKEN` 或 `GITHUB_TOKEN` 下载明确私有 Release 的 `v<版本>` 包及 `SHA256SUMS`，执行 `mate node update --version 0.2.0`。Mate 不安装下载工具、不保存登录配置，不转发下载工具可能包含凭据的诊断；仅 update 的获取阶段使用临时鉴权，原生预检、系统服务命令和 node 进程不继承这些变量。完成后清除自己的临时变量。这里描述的是下载接口，本地验收使用获取替身，不证明实际私有 Release 的网络兼容性。

更新持有与 install/start/restart/stop/uninstall 相同的短暂本机管理锁，检查 user manager 当前确实停止、PID 为 0、没有排队任务；下载及复制后再检查，运行中或正在重启会拒绝。锁只互斥 Mate CLI；所有者应避免维护中用原始 systemctl 或其它程序同时改 Mate 文件。enabled/disabled 选择保留，更新结束仍保持停止。配置、节点身份、命令收据、Agent 工作区和控制面数据保留。服务运行状态不表示节点已配对或在线，最后在网页与 journal 核对。

下载、版本、平台、校验和、完整文件清单、专用 Node/CLI/原生依赖预检在改变活动入口前完成，不启动 node、不连接控制面、不写现有数据。失败保留旧入口和单元。正常更新保留旧包，正在执行的旧 CLI 可报告结果并退出，下次公共命令使用新包；保留旧程序不提供回滚承诺。

## 中断与损坏恢复

入口、单元和 systemd reload 是独立实际事实，中断时可能暂时不一致。`mate node status` 返回非零并报告未完成；`mate node start` 拒绝混合引用。保持停止，再用同一 update 参数重试即可补完；不需要重新 install/start 或重做配对。单元移出后中断时，旁边保留的原单元文件可作为恢复证据；未知或被修改的对象会保留并报冲突，不因文件名像 Mate 就删除。

公共入口不可执行时，先用可信来源的 SHA-256 校验本地完整包，再在私有临时目录解包，直接用包内专用 Node 执行相同 CLI。以下步骤不依赖系统 Node：

```sh
set -eu
PACKAGE=/path/mate-node-0.2.0-linux-arm64.tar.gz
SHA256='<对应包的64位SHA-256>'
printf '%s  %s\n' "$SHA256" "$PACKAGE" | sha256sum -c -
RECOVERY=$(mktemp -d)
tar -xzf "$PACKAGE" -C "$RECOVERY" --no-same-owner --no-same-permissions
BUNDLE="$RECOVERY/mate-node"
"$BUNDLE/node/bin/node" "$BUNDLE/app/apps/node/dist/management/cli.js" \
  node update --version 0.2.0 --package "$PACKAGE" --sha256 "$SHA256"
rm -rf "$RECOVERY"
```

缺失或指向 Mate 版本目录的损坏入口可修复；非 Mate 文件/链接仍拒绝覆盖。同版程序损坏也可从上述外部完整包修复：原 `bundle.json` 必须与校验后的同版包清单完全相同，剩余文件与目录必须都能由该清单确认、属于当前账号且无链接或未知文件。CLI 不挪走自己正在执行的损坏包，因此这种修复要求外部包入口；它将已确认的损坏程序移出，安装同版完整包，并在操作完成后清理旧损坏程序。清理将清单留到最后，中断可重试。清单本身损坏、版本清单不同或存在未知对象时，保留并明确拒绝，不靠盲目覆盖隐藏冲突。

## 可独立重跑的真实用户服务验收

在授权的可丢弃 Linux 宿主或 VM 的现有普通账号中运行；需实际 user manager，账号不能已有 Mate 文件，PATH 无系统 Node，Mate 不配置账号、linger、权限提升或系统软件：

```sh
sh deploy/node/tests/update-smoke.sh \
  /path/mate-node-0.1.0-linux-arm64.tar.gz /path/bootstrap.sh \
  '<SHA-256>' 0.1.0 /path/update-cut.mjs
```

脚本从同一实际完整构建生成兼容合成发布版本，以真实 bootstrap、CLI、systemd 用户服务验证整包与 CLI 自身更新、下一次版本、停止/禁用保留、坏校验和与新 CLI 预检失败、实际进程在入口/单元/reload 之间中断、并发管理拒绝及损坏入口/同版包的外部 CLI 恢复。外部观察器只读文件并向本次测试 CLI 发信号，未引入产品钩子；未捕捉实际中断则明确失败。观察窗口默认 180 秒，慢速架构模拟 VM 可用 `MATE_TEST_CUT_TIMEOUT_SECONDS=600` 同时扩大观察器与 shell 等待，取值限 1–1800 秒；这只控制测试等待，不改变产品或通过条件。私有 Release 获取使用标明的 gh 替身；控制面 URL 故意不可达，服务 PID 不作为在线证据。数据、身份、收据和工作区保留。

这个入口不代表四种目标环境已验收。每次报告分别记录 Ubuntu 24.04/Debian 13、x64/arm64、账号、宿主/VM、实际 manager、包版本及结果；容器、macOS、早期分支替身、脚本语法检查不能替代真实运行。真实 provider、控制面联通、linger 注销/重启与 VPS 部署分别验收。
