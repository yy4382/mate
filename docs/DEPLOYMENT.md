# Debian 13 首次部署

完整安装前提、Slack manifest、只读运维和升级步骤见 [运维手册](OPERATIONS_RUNBOOK.md)。

首次安装只支持 Debian 13 x86_64、Node 24、pnpm 10.33、systemd 和系统 Docker 的固定拓扑，以及同一身份的幂等重跑。升级 release 使用独立的 candidate/activate/rollback 流程；改变 Agent 或 mount topology 不属于当前原地升级能力。installer 遇到非受管安装或不同 identity 会停止，不接管或覆盖。

## 准备候选

在目标机的普通临时目录使用完整、标准的pnpm安装；不要裁剪依赖或复制另一台机器的native addon：

```sh
pnpm install --frozen-lockfile
pnpm test

install -d -m 0755 /var/tmp/mate-release
cp package.json pnpm-lock.yaml /var/tmp/mate-release/
cp -a dist /var/tmp/mate-release/
cd /var/tmp/mate-release
pnpm install --prod --frozen-lockfile --package-import-method=copy
cd /ABSOLUTE/MATE/SOURCE
pnpm --silent run deploy release-manifest /var/tmp/mate-release "$MATE_COMMIT" > /var/tmp/mate-RELEASE.json
mv /var/tmp/mate-RELEASE.json /var/tmp/mate-release/RELEASE.json
```

`MATE_COMMIT` 必须是构建源码的实际提交，`release.source` 指向这个带 `RELEASE.json` 的完整目录。构建、生成 manifest 和目标机 `/usr/bin/node` 必须使用相同的精确 Node 版本与 ABI。`package.json`通过pnpm的`onlyBuiltDependencies`明确批准`fs-ext`和`better-sqlite3`。release manifest会记录精确Node版本/ABI、lockfile、`dist`、实际依赖inventory和所有`.node`内容hash；内部symlink必须留在release内，hardlink的全部链接也必须都在同一不可变release树中。

复制并修改[mate.example.json](../mate.example.json)和[mate.deploy.example.json](../mate.deploy.example.json)。managed配置固定使用`/var/lib/mate`、`/etc/mate/workspaces.json`、`/usr/bin/docker`和`unix:///var/run/docker.sock`。Docker image必须是目标机已有的完整sha256 ID。private容量没有override时为512 MiB；每个唯一external grant root必须在deployment spec中恰好出现一次，其父目录必须已经存在，最终叶目录必须不存在或为空。首版部署路径只接受systemd安全的绝对路径字符。

plan和preflight不写宿主：

```sh
pnpm run deploy plan /ABSOLUTE/mate.deploy.json
sudo pnpm run deploy preflight /ABSOLUTE/mate.deploy.json
sudo pnpm run deploy install /ABSOLUTE/mate.deploy.json
```

plan显示两份release预留、state预留、每个完整预分配backing、固定Docker image及本机可读取到的已安装大小，以及daemon加最大并发container的内存上界。image已经存在于系统Docker中，因此其大小单列报告，不重复计入Mate新增空间。preflight核对Debian/Node、root-owned系统工具、release 的精确版本与 native ABI、现有image、磁盘、内存、服务停止状态和旧安装边界；install 建立并核对专用 nologin 服务账户。install先写持久bootstrap journal，再按`truncate → mkfs.ext4 → fallocate`创建本transaction的新backing；每个目录、staging和final对象都核对identity。日志提交前会同步release文件树、目录和backing；中断后用完全相同的spec/config/release重新运行install，预检只计算尚未持久化的资源，identity不同会拒绝。

安装生成root-owned content-addressed release、`root:mate`配置、三个层次分离的数据/backing/checkpoint目录、每root一个mount unit、`mate.service`和`/usr/local/sbin/matectl`。`mate`不是docker组的永久成员；只有主服务和固定maintenance one-shot通过`SupplementaryGroups=docker`取得控制能力。安装会运行candidate doctor与offline probe，最后发布`/opt/mate/current`，但不会enable或start主服务。

主服务使用 systemd `Type=notify`：完成执行环境探针、凭据和 Slack 初始化与历史追赶后才报告 ready。启动默认限期 900 秒；只有恢复页实际推进时才延长期限，停滞会由 systemd 判为启动失败。`start` 命令要求 systemd 通知环境；开发实验使用 `local`。

## 检查、启动与停用

把实际secret按`NAME=value`写入`/etc/mate/mate.env`，保持`root:mate 0640`。先检查：

```sh
sudo matectl doctor
sudo matectl offline-probe
sudo systemctl enable --now mate.service
```

`doctor`只读配置、release、mount、image/socket、secret引用和service状态；不取scope、不建库、不recover、不写nonce，也不连接Slack/provider。`offline-probe`要求主服务停止，取得同一daemon lock后recover本deployment scope，并对所有private/external root做双向container probe。

维护入口还支持无参数的 `status`、`logs` 及升级命令；具体语义见运维手册。checkpoint只能是`/var/backups/mate`下最长64字符的简单名称；wrapper不接受任意config、绝对路径、命令、property或environment参数。backup由mate身份创建后再由root封存，restore只读封存checkpoint。

非破坏性停用：

```sh
sudo pnpm run deploy disable /etc/mate/mate.json
```

它先停止主服务并执行scope recovery/probe，再按逆序正常停止mount units；EBUSY会失败，不使用lazy unmount。state、backing、checkpoint、unit和release全部保留。部署工具没有删除数据或backing的命令。
