# V2c Debian 部署包与 doctor — PASS

日期：2026-09-22。实现前只读设计复核：`/root/v2c_design_audit`。独立只读代码红队：`/root/review_d`，未参与实现。范围：固定 Debian 13 首次部署、release 身份、服务账户、ext4 workspace、systemd 单元、被动 doctor、离线探针、受限 root wrapper、幂等与中断恢复，以及目标 VPS 原生验收。

实现结果：strict deployment spec 只接受 release/config/environment 来源、private 容量 override、唯一 external root 容量、state 预留和 daemon 内存。plan 规范化 Agent/grant 拓扑，报告两份 release、全部 backing、state、已安装 Docker image 大小以及 daemon/container 并发内存上界；image 已存在于系统 Docker，因此单列而不重复计入新增空间。preflight 固定要求 Debian 13 x86_64、Node 24、受保护的系统工具、已有的精确 image、足够磁盘/内存、停止的主服务和相同安装 identity。

installer 建立专用非 root、nologin 的 `mate` 账户；账户没有永久补充组，主服务与 maintenance one-shot 才通过 systemd 临时获得 docker 组。固定目录分别保存不可变 content-addressed release、root 控制配置、service-owned state、root 控制的完整预分配 ext4 backing 和 checkpoint。systemd mount/service renderer、`matectl` allowlist wrapper、doctor 与 offline-probe 都不接受调用者替换 executable、config、environment、property 或任意路径。安装完成后主服务仍 disabled/inactive，缺 secret 不会触发 Slack/provider 连接。

release identity 覆盖 Git commit、lockfile、`dist`、实际生产依赖、Node/ABI、native addon、相对 symlink 和闭合 hardlink inventory。bootstrap/control journal 绑定目录、release staging/final、backing、mountpoint 及 cleanup 对象的 device/inode；文件树、目录和 backing 在推进状态前 fsync。恢复同时识别 staging 和 final，按已经持久化的资源计算剩余磁盘需求。mount 后中断会核对 exact target、ext4 options 与关联 loop backing，再补完 ownership、fsync 和正常卸载。重复 release 的半清理目录由独立 cleanup identity 约束，删除中断可继续，路径被替换则失败关闭。`current` 发布到 completion marker 之间仍由未完成 journal 恢复。

红队共六轮。初审发现 current/marker 窗口、mount 后 ownership 窗口、恢复空间重复计费和 payload 未持久化四项 P1；随后逐轮复现并修复 rename 已完成但状态未推进、mountpoint `mkdir` 窗口、未绑定 staging 前置门禁、完整安装重复执行误读已挂载 workspace、同 release identity 切换，以及重复 staging 半删除后无法恢复。每个问题都加入前置门禁到实际恢复路径的回归；最后一轮用完整 `publishRelease` 调用验证半清理续作。Docker image 大小报告与服务身份完整校验也一并补齐。最终独立判定 P0=0、P1=0、无验收阻塞。

本机与红队最终均通过 typecheck、402 tests，10 项需要真实隔离环境的测试显式跳过。`ncDE` 使用 Git archive 的精确 `ff6ca92` 源码，并执行完整标准 `pnpm install --offline --frozen-lockfile`、typecheck、全量测试和独立 production install；259/219 个包全部来自现有 pnpm store，下载为 0，没有裁剪依赖、复制 native addon 或拼装运行时。

`ncDE` 原生验收创建两个 private 和一个 external 的真实 64 MiB ext4 loop workspace。首次安装与同 identity 幂等重跑得到同一 release；backing 均为完整预分配的 `root:root 0600` 文件，mount 为 `rw,nodev,nosuid`。systemd 单元语法、专用账户、临时 docker supplementary group、服务 inactive/disabled、release/current identity均通过。doctor 前后 state/container/mount 快照 hash 相同，只因合成环境缺 `MODEL_API_KEY` 返回预期不健康；其余结构检查通过。offline-probe 覆盖三个 root 且无容器/数据库残留。真实服务短暂启动后常驻进程为 mate UID/GID 并含 docker supplementary group，运行中 offline-probe 被拒绝；随后服务停止且合成 secret 清空。wrapper 拒绝额外参数、路径穿越和 property 注入，缺 mount 时 doctor 失败关闭。disable 后 state、workspace、checkpoint 与 backing 的合成 marker 全部保留。

验收结束后删除了测试 release、配置、unit、wrapper、mount、loop/backing、checkpoint、`/srv` 测试 root、sysusers 配置、上传包和全部 `/var/tmp/mate-v2c*` 材料。预先隔离的原始 `/opt/mate` 与 `/var/lib/mate` 已原样移回；`/opt/mate/current` 仍指向 `/opt/mate/releases/11e520d`，原 data 目录仍为 `mate:mate 0700`，没有 Mate 测试 unit、mount、loop 或永久 docker 组成员残留。

V2c 最终 PASS。V2d 可以在这些固定初装边界之上实现非活动 candidate、不可逆 activate/finalize/fix-forward、日志诊断和 Slack 接线闭环；不能把 V2c 的同 identity 重跑扩展成隐式升级。
