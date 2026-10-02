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

联通脚本另用镜像内 SQLite 创建 schema revision 999 的合成外部控制面数据库，实际生产入口拒绝后核对数据库 SHA-256 未改变；现有 `pnpm check` 还覆盖格式/结构错误持久化边界。包装工具不迁移数据库、重建身份或重放未知副作用。包装矩阵不是 A 的深层 runtime 故障矩阵替代品。

## 已执行证据与发布缺口

下表只记录实际结果；后续运行须附被测 source、包 SHA-256、镜像 ID、系统/架构、账号、host/VM/container、真实 manager 或替身。`PASS` 必须来自脚本完成且进程退出 0，早期输出或产物生成不算通过。本轮没有实际 VPS、Release 或 GHCR 发布。

| 实际环境 | 已执行项目 | 当前结果与边界 |
| --- | --- | --- |
| Ubuntu 24.04 arm64，官方 cloud image 的 HVF VM，账号 UID/GID 1000，真实 systemd 255，Linger=no | #134 完整包；#135 用户服务，source `8a56fb5326a77138a02fb5e24def8b83ac7212f8` | 两项 PASS；更新、卸载最终组合另行记录 |
| Debian 13 arm64，官方 cloud image 的 HVF VM，账号 UID/GID 1000，真实 systemd 257，Linger=no | 同上 | 两项 PASS；更新、卸载最终组合另行记录 |
| Ubuntu 24.04 x86_64，官方 cloud image 的 QEMU TCG 架构模拟 VM，账号 UID/GID 1000，真实 systemd 255，Linger=no | 同上 | 两项 PASS；不是原生 x86_64 性能测量；更新、卸载最终组合另行记录 |
| Debian 13 x86_64，官方 cloud image 的 QEMU TCG 架构模拟 VM，账号 UID/GID 1000，真实 systemd 257，Linger=no | 同上 | 两项 PASS；不是原生 x86_64 性能测量；更新、卸载最终组合另行记录 |
| Ubuntu 24.04 原生 x86_64 hosted VM | 最终同版镜像/包联通及隔离 Docker 恢复 | 新入口待实际执行，不填写通过 |
| macOS 驱动的 Orb Linux arm64 容器 | #133 实际镜像/Compose、私有挂载、配对、附件、密码移除后替换、异常退出和显式停止 | PASS；容器结果不是四 VM 用户服务或 Docker daemon 重启证据 |

四 VM 当前均没有预配置 linger。没有执行“预配置 linger 后注销仍运行”及“开机用户 manager/服务自动运行”，因此这两项仍未验收，#138 与 #131 不能据上述成功宣称完整发布矩阵通过。Mate 不为填表擅自配置 linger。后续需用户已准备好的 Linger=yes 隔离宿主/VM，记录注销前后会话事实、原服务 PID/身份、开机前后 boot ID、服务 enable/active 和日志；新登录启动 manager 不能冒充开机自动运行。

真实模型 provider 的传输兼容、公开 HTTPS/WSS/Web Push、实际私有 Release 下载、GHCR 获取和 VPS 部署仍单独执行。脚本化 provider、获取替身和本地构建证据均保留各自名称，PR 必须列出这些缺口，不收缩原验收矩阵。
