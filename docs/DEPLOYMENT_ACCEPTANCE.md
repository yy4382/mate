# 实际交付与 Linux 用户服务验收

验收对象是明确版本的控制面镜像、生产 Compose、薄 bootstrap 和同版完整 node 包。构建成功只证明产物生成；容器证明 Linux 用户空间中的包装行为；真实宿主或 VM 的 user manager 才能证明用户服务。测试 provider 是脚本 HTTP/SSE 或 WebSocket 协议替身，不能填写真实模型供应商已连接。

## 实际镜像与完整包联通

在授权的隔离 Linux 宿主或 VM，以已有普通账号运行，预先具备常规 Docker/Compose、空闲 loopback 8787 和匹配架构的实际镜像与完整包。测试脚本本身可以从 checkout 取得，但不导入 checkout 应用代码或依赖；bootstrap 安装包后，测试驱动与 node 全部使用包内专用 Node。构建机器有 Node/编译器不代表运行需要它们，四个干净 VM 的独立包装验收另行核对此项。

```sh
sh deploy/tests/delivery-smoke.sh \
  mate-control-plane:0.1.0 \
  /absolute/mate-node-0.1.0-linux-x64.tar.gz /absolute/bootstrap.sh \
  '<该包的64位SHA-256>' 0.1.0
```

版本参数与镜像标签中的发布版本须相同；提供包旁 `SOURCE_COMMIT` 时脚本还核对镜像 revision。测试开始记录实际 `/etc/os-release`、架构、账号 UID/GID、虚拟化事实、运行时、包体积、镜像 ID/revision/体积及所需系统库。

测试先用未改生产 Compose 和镜像入口完成首次初始化、登录及网页/PWA 请求，再移走密码原路径并移除初始化 override。真实 Pi 运行阶段叠加独立测试 override：仅挂载调用镜像内 `startControlPlane` 的小入口，并把模型 HTTP/SSE 地址指向宿主 Docker bridge 上的合成 provider；保持生产服务、账号、数据 bind 与 loopback 端口。生产 Compose 不包含 provider、源码、宿主工作区或测试网络设置。

通过网页同用的所有者 API 配对、创建 Agent 与消息任务；真实 WebSocket/Pi/SQLite 调用普通命令、文件读写及从 node 工作区发布附件。演练核对命令账号和工作目录、文件归属、单次副作用、原节点和 Agent ID、任务、工作区与唯一 session；容器替换和 node 重启后再次登录，不使用密码文件或新令牌，并从持久模型上下文继续原 session。没有读内部数据库代替用户接口。

正常及信号退出清理本次 node 进程、Compose 容器和项目网络，合成私有测试文件保留在打印的临时目录，供操作者查看。脚本不会删除已有用户数据、Docker 镜像或缓存。资源采样记录该演练下 node 的 `/proc` RSS、容器 `docker stats`、包/控制面/node 的 `du` 和压缩包字节数；不能据此宣传未经测量的最低 VPS 配置，也不能把整个 VM 已用内存算作 Mate 进程内存。

独立 `Node package validation` workflow 在预配 Ubuntu 24.04 原生 x86_64 GitHub hosted VM 上构建同版镜像和完整包，执行上述联通验收。其 `--docker-daemon-recovery` 选项只接受 GitHub hosted runner、本地默认 Docker socket 和无其它容器的隔离环境；按已有 sudo 策略重启已运行的 Docker，验证异常容器恢复以及显式 stop 在 Docker 重启后保持停止。它不修改账号、权限、守护进程配置或 linger。不要在用户当前 Docker 上执行这个选项。

该 workflow 只有仓库内容读取权限，保留带 `SOURCE_COMMIT` 的私有短期包 artifact；它不发布 Release/GHCR，也不增加 A #130 的 PR/main runtime 故障矩阵。A 可以复用 `pnpm build:image:control-plane`、`pnpm test:image:control-plane`、`pnpm build:bundle:node` 和本票独立交付命令；其 provider、网络及故障 override 不进入生产 Compose。

## 真实 bootstrap → CLI → 用户服务

使用用户已经准备好的可丢弃 Ubuntu 24.04 或 Debian 13 x86_64/arm64 宿主/VM、已有普通测试账号和真实 user manager。每条外部脚本要求新鲜账号目录，不要在日常 Mate 数据或前一条脚本留下的配置上执行；使用独立 VM overlay 或另一个已准备好的测试环境。脚本不创建账号、安装软件、修改 sudo/Docker/linger。PATH 不能有宿主 Node，包不借宿主 pnpm/编译器补全。

```sh
# 四个系统/架构组合分别运行，使用与该架构匹配的包。
sh deploy/node/tests/bundle-smoke.sh ARCHIVE BOOTSTRAP SHA256 VERSION
sh deploy/node/tests/user-service-smoke.sh ARCHIVE BOOTSTRAP SHA256 VERSION PEER_MJS
sh deploy/node/tests/update-smoke.sh ARCHIVE BOOTSTRAP SHA256 VERSION UPDATE_CUT_MJS
sh deploy/node/tests/uninstall-smoke.sh ARCHIVE BOOTSTRAP SHA256 VERSION PEER_MJS UPDATE_CUT_MJS
```

`PEER_MJS` 是交付测试目录中的 `user-service-peer.mjs`；`UPDATE_CUT_MJS` 是 `update-cut.mjs`。包验证覆盖获取/校验/平台/原生依赖、目录权限与冲突；用户服务覆盖真实安装、拒绝令牌后原身份重试、日志、重复安装、停止/禁用、异常重启和缺 manager。更新与卸载通过外部文件/进程观察器对真实 CLI 发信号，在入口、安装、单元、reload、修复清理或卸载之间中断；观察不到实际中断就失败。预检错误保留旧安装，并发 Mate 管理拒绝，混合版本不能假报正常，保留配置/身份/数据，重装沿用原身份。具体边界见 [完整包](NODE_BUNDLE.md)、[用户服务](NODE_SERVICE.md)、[更新](NODE_UPDATE.md)及[卸载](NODE_UNINSTALL.md)。慢速架构模拟更新观察可设置 `MATE_TEST_CUT_TIMEOUT_SECONDS=600`，不改变通过条件。

预配置 Linger=yes 的真实宿主/VM 另有三阶段只读观察入口。首先由 Mate 的普通账号安装并 enable/start 服务，让 node 空闲、身份文件已存在。观察命令由该账号登录会话之外的已有 VM supervisor 执行；开机后观察需要它已有的系统 journal 完整读取权限，不执行 root Mate CLI，不新建账号或权限。以下每步中的路径是同一份 VM 外部观察文件，必须随 VM 重启保留：

```sh
# 普通 Mate 账号仍登录时；observer 本身不能使用该账号。
sh deploy/node/tests/linger-smoke.sh before-logout 1000 /home/ubuntu \
  /home/ubuntu/.local/share/mate/node/node-identity.json /private-observer/linger-facts
# 操作者关闭该账号全部现有登录会话，再从已有外部 supervisor 执行。
sh deploy/node/tests/linger-smoke.sh after-logout 1000 /home/ubuntu \
  /home/ubuntu/.local/share/mate/node/node-identity.json /private-observer/linger-facts
# 操作者在已授权隔离环境重启 VM；在任何 Mate 账号登录之前，supervisor 执行。
sh deploy/node/tests/linger-smoke.sh after-boot 1000 /home/ubuntu \
  /home/ubuntu/.local/share/mate/node/node-identity.json /private-observer/linger-facts
```

观察器拒绝容器、Linger=no、同账号观察和当前仍有 owner 会话的情况；注销后要求原 manager/node 的 PID 与进程启动时钟均未改变。开机后要求 boot ID 变化、已有 enabled 单元的 cgroup 内存在该账号的专用 node 进程，并核对原单元/身份 hash；还读取本次 boot 的完整 logind journal，拒绝 owner 曾登录再注销后才观察的情况。systemd [255](https://github.com/systemd/systemd/blob/v255/src/login/logind-session.c#L734) 与 [257](https://github.com/systemd/systemd/blob/v257/src/login/logind-session.c#L794) 的会话日志都带用户名 `USER_ID` 和 `SESSION_ID`，检查使用这些字段，不靠当前会话列表为空冒充未登录。脚本不注销会话、重启 VM、启动 user manager 或配置 linger；缺环境权限/证据就失败，不能填写通过。

联通脚本另用镜像内 SQLite 创建 schema revision 999 的合成外部控制面数据库，实际生产入口拒绝后核对数据库 SHA-256 未改变；现有 `pnpm check` 还覆盖格式/结构错误持久化边界。包装工具不迁移数据库、重建身份或重放未知副作用。包装矩阵不是 A 的深层 runtime 故障矩阵替代品。

## 本轮验收来源与发布缺口

下表是绑定被测 source 和版本的历史验收证据，不代表任意后续 HEAD。详细运行记录、首次失败、修复与复验结果以 [#138](https://github.com/yy4382/mate/issues/138)、[更新 #136](https://github.com/yy4382/mate/issues/136)、[卸载 #137](https://github.com/yy4382/mate/issues/137) 和[草稿 PR #153](https://github.com/yy4382/mate/pull/153) 为准。`PASS` 必须来自脚本完成且进程退出 0，早期输出或产物生成不算通过。本轮没有实际 VPS、Release 或 GHCR 发布。

| 实际环境 | 已执行项目与来源 | 结果范围 |
| --- | --- | --- |
| Ubuntu 24.04 arm64，官方 cloud image 的 HVF VM，账号 UID/GID 1000，真实 systemd 255，Linger=no | 历史 #134 完整包；#135 用户服务（用户服务 source `8a56fb5326a77138a02fb5e24def8b83ac7212f8`） | 两项 PASS；版本均为 `0.1.0`，所测产物标识见下表 |
| Debian 13 arm64，官方 cloud image 的 HVF VM，账号 UID/GID 1000，真实 systemd 257，Linger=no | 同上（版本 `0.1.0`） | 两项 PASS；所测产物标识见下表 |
| Ubuntu 24.04 x86_64，官方 cloud image 的 QEMU TCG 架构模拟 VM，账号 UID/GID 1000，真实 systemd 255，Linger=no | 同上（版本 `0.1.0`） | 两项 PASS；不是原生 x86_64 性能测量 |
| Debian 13 x86_64，官方 cloud image 的 QEMU TCG 架构模拟 VM，账号 UID/GID 1000，真实 systemd 257，Linger=no | 同上（版本 `0.1.0`） | 两项 PASS；不是原生 x86_64 性能测量 |
| Ubuntu 24.04.5 原生 x86_64 Microsoft hosted VM，账号 UID/GID 1001 | [Actions 37004417625](https://github.com/yy4382/mate/actions/runs/37004417625)，source `e11196b3fb4bf6b49498c021b09debb93b1fadaf`，版本 `0.1.0` | 同版镜像/完整包联通与隔离 Docker 恢复 PASS；驱动和 node 使用包内 Node `24.21.0`，不包含 user manager 生命周期验收 |
| macOS 驱动的 Orb Linux arm64 容器 | 历史 #133 实际镜像/Compose、私有挂载、配对、附件、密码移除后替换、异常退出和显式停止，来源见下文 | PASS；容器结果不是四 VM 用户服务或 Docker daemon 重启证据 |

原生联通验收的镜像 ID 为 `sha256:bd1bb43b5e781e392a95b359222127830cd40ce1e9ab3f4170ad7dabacda6449`，镜像体积 354,505,451 字节；完整 x64 包 SHA-256 为 `05db4095e5bb886672763da9db4816a56096fcee96342956bb6af5d81106221e`，压缩包体积 89,505,812 字节。镜像 revision 与包旁 `SOURCE_COMMIT` 均为上述 `e11196b3` 来源。脚本实际完成首次登录、配对与普通工具操作、容器替换及 node 重启后的持久状态恢复、密码文件移除后重建、隔离 Docker 异常恢复及显式 stop 保持停止，并拒绝 schema revision 999 的外部数据库且保留原字节。

该次确定性演练采样为 node RSS 91,100 kB、控制面容器 115.2 MiB；完整包展开占用 275,004 KiB，控制面数据 1,300 KiB，node 数据 56 KiB。构建 VM 已有系统 Node 和编译器；运行过程使用专用包内 Node。四个真实 VM 的登录 PATH 检查未找到 `node`、`pnpm` 或 `cc`，程序运行只使用包内 Node，不调用宿主 pnpm/编译器；包装验收来源在下表记录。上述数字是指定演练的观察值，不是最低 VPS 配置或使用配额。

上述四个真实 user-manager VM 的更新和卸载结果如下。包标识在下表绑定各次被测 source；更新演练从实际基础包派生合成兼容版本，用于整包切换和中断恢复，未下载真实 Release。

| 实际 VM | 更新 #136 | 卸载 #137 |
| --- | --- | --- |
| Ubuntu 24.04 arm64，HVF，UID/GID 1000，systemd 255，Linger=no | source `67ed17b0`，完整演练 PASS / exit 0 | source `e11196b3`，完整演练 PASS / exit 0 |
| Debian 13 arm64，HVF，UID/GID 1000，systemd 257，Linger=no | source `67ed17b0`，完整演练 PASS / exit 0 | source `e11196b3`，完整演练 PASS / exit 0 |
| Ubuntu 24.04 x86_64，QEMU TCG 架构模拟，UID/GID 1000，systemd 255，Linger=no | source `67ed17b0`，完整演练 PASS / exit 0 | source `e11196b3`，完整演练 PASS / exit 0 |
| Debian 13 x86_64，QEMU TCG 架构模拟，UID/GID 1000，systemd 257，Linger=no | source `e11196b3`，首次 FAIL / exit 1；从原失败状态接续尾部 RECOVERY_PASS / exit 0，范围见下文 | source `e11196b3`，完整演练 PASS / exit 0 |

Debian x86_64 更新首次在同版本损坏程序恢复阶段，因读取有效 `ExecStartEx` 的子进程达到原有 10 秒截止而报 `ETIMEDOUT`，原因未确定；首次失败保留，不能称四组合首次全部通过。接续验收使用原失败磁盘的新 overlay，原磁盘大小、mtime 和 SHA-256 前后均未改变；核对原 `data.before` 和外部完整包的全文件清单后，以原 CLI 对原合成包执行一次真实重试。完整安装、原生依赖、入口及单元引用、修复备份清理、原配置和数据哈希、显式 start/stop 均通过。预登录 fixture 临时移走并恢复原 Mate 单元的 enablement 链接以防自动启动，这是测试准备，不是 Mate 的恢复行为；只读诊断成功也不代替该接续验收。详细失败及接续链见 [#136](https://github.com/yy4382/mate/issues/136) 和[草稿 PR #153](https://github.com/yy4382/mate/pull/153)。

| 验收用途 | 基础版本 / 架构 | 压缩包 SHA-256 | 绑定来源 |
| --- | --- | --- | --- |
| #136 两个 arm64 VM 更新 | `0.1.0` / arm64 | `eb5c16766085817e9a1cf3aff5acb71cbacdc3cb3f84e8deca661262ac7b0394` | `67ed17b0c9acdb2ec8d45bf145137ede454d6f18` |
| #136 Ubuntu x86_64 VM 更新 | `0.1.0` / x64 | `f72bec826cc459f5942576ed0b208ac56500bec2f247351ee8cadef1e24dcb6f` | 同一 `67ed17b0` |
| #137 两个 arm64 VM 卸载 | `0.1.0` / arm64 | `579b9fdd90283e62d07932444a09ca9836677960a26c4f3f9d982ad10b049989` | `e11196b3fb4bf6b49498c021b09debb93b1fadaf` |
| #136 Debian x86_64 更新与接续；#137 两个 x86_64 VM 卸载；原生联通 | `0.1.0` / x64 | `05db4095e5bb886672763da9db4816a56096fcee96342956bb6af5d81106221e` | 同一 `e11196b3` |

#134/#135 已实际运行的历史包标识，不表示最终候选产物：

| 测试 | 版本 / 架构 | 压缩包 SHA-256 | 绑定来源 |
| --- | --- | --- | --- |
| #134 完整包 | `0.1.0` / arm64 | `d19d52f5c414d46b9fc13fd7ccb6b605343874cd4ac07cc62ba6a4406fb6c37b` | 原本地构建没有 `SOURCE_COMMIT` 文件；实际包清单和四 VM 原始验证结果见 [#134](https://github.com/yy4382/mate/issues/134)，不补造来源标记 |
| #134 完整包 | `0.1.0` / x64 | `5073f8f5745c6d1bc1ddd2837ebbdd7d8938ab84387e552482a755cbc6869fcb` | `357d460657790092a0cdac1564ee998e6d7c5712`，[原生构建 Actions](https://github.com/yy4382/mate/actions/runs/36976798658) |
| #135 用户服务 | `0.1.0` / arm64 | `6ef1ef557de9c7215345122cd2b006d901269e99f747283f58c557e0a59c0fa8` | `8a56fb5326a77138a02fb5e24def8b83ac7212f8` |
| #135 用户服务 | `0.1.0` / x64 | `cc6a8393f7e1f9432969ad2c889c38f011877cec4f0e89f8274061b5b179c7b7` | 同一 `8a56fb5`，[原生构建 Actions](https://github.com/yy4382/mate/actions/runs/36986065923) |

#133 历史 arm64 镜像为 `mate-control-plane:ticket133`，发布版本 `0.1.0-ticket133`，revision `0bf1179e73155410b0309b8d85f6b5e756f2d255`，image ID `sha256:c3d59820a5f33b15f7ca6500f8b69ad3a29ad80e76b35f43abf6e6d4a83586d6`，镜像体积 372867138 字节；[票据证据](https://github.com/yy4382/mate/issues/133#issuecomment-5946788178) 明确使用的是开发 node 接口，而非同版完整包联通。因此它只证明该历史来源和范围，不替代上述原生同版完整交付验收。

本轮上述 source 的四个真实 user-manager VM 均为 Linger=no；没有预配置 Linger=yes 的真实宿主/VM 注销和开机证据。这两项未验收，不能据上述成功宣称完整发布矩阵通过。Mate 不为填表擅自配置 linger；新登录启动 manager 不能冒充开机自动运行。

本轮未验证真实模型 provider 的传输兼容、公开 HTTPS/WSS/Web Push、实际私有 Release 下载、GHCR 获取或 VPS 部署。脚本化 provider、获取替身和本地构建证据均保留各自名称，不能据此推导这些集成已经验收或收缩原矩阵。
