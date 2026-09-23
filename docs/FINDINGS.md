# Review Findings：需修改计划的架构/功能问题

**文件定位（先读这一段）**

- 本文件记录**用户（人）在 review 中发现的高层次架构或功能实现问题**。这类问题的共同点：现有计划的前提不成立，需要**较大幅度修改原有计划**（新增/调整模块与设计契约），或必须在实现 Agent 动手前由用户对齐方向。
- 只写最终 finding：问题、证据、为什么现有计划不成立、需要改动什么。中间讨论、被推翻的猜测、过程性叙述不写入。
- **不收**：实现 Agent 进行中的工作、失败测试等执行状态；文档滞后、命名等例行维护；以及实现 Agent 能按既有计划自行处理的小问题。
- 每条 finding 是独立的**二级标题**（F1、F2…），同一议题的分支放在三级标题（F1.1、F1.2…）。可直接引用编号讨论。
- 本文件不是实施计划（`docs/IMPLEMENTATION_PLAN.md`）、不是设计定稿（`docs/ARCHITECTURE.md`）、不是审核记录（`docs/reviews/`）。结论确定后由实现 Agent 决定转移进正式设计/计划，并按 `AGENTS.md` 的 gate 流程走独立红队。**沙盒相关的任何改动都不能跳过设计红队。**
- 证据引用代码、文档和实际命令输出；不使用私有参考或运行数据。

---

## F1 沙盒

**状态：待议。问题（review 发现）：per-op 短生命周期容器开销不可接受，需要改为每 Agent 的持久隔离，并解决进程终止语义与目标机能力限制。**

**对原计划的影响**：现有执行后端与部署资源预算建立在 per-op 容器 + 全局串行之上（V1b/V2 已按此验收）。修改意味着把 `src/execution/*`、workspace/grant 挂载语义、部署 plan 与 `environment.info` 契约一起重新设计成新模块，按独立红队 gate 实施，而不是修补现有实现。

### F1.1 实测数据：per-op 与持久模式（ncDE 原生）

当前 `src/execution/container.ts` 为"一次操作一个容器"：每次 `create` → `start --attach` → `rm --force --volumes`，文件操作和 exec 相同；文件 helper 每次冷启动。`AdmittedBackend` 默认 `maxBackendOperations: 1`，全局串行。

目标机 `ncDE`（Debian 13.7、4 vCPU QEMU、约 4 GiB RAM、Docker 26.1.5 + runc、cgroup v2）原生实测：

| 场景 | ncDE 原生 |
|---|---|
| per-op 文件 helper（create + start + rm） | 302 ms（create 33 / start 267 / rm 19） |
| 持久容器启动一次 | 158 ms |
| 持久容器 `docker exec` 文件 helper | 123 ms |
| 持久容器 `docker exec` shell | 70 ms |
| 空闲持久容器内存 | ~0.3–1 MB（`docker stats` 340 KiB，cgroup `memory.current` 946 KB），CPU 0% |

事实：shell 类 exec 在 per-op 模式下每次支付约 300 ms 的容器生命周期开销；持久模式下批量操作放进单条 exec 时边际成本接近 0。

### F1.2 使用持久 Docker（每 Agent 一个 generation）

generation key = `agentId + 挂载集合 + network + resources + image digest`；操作走 `docker exec`，文件 helper 在容器内运行；容器层承载沙盒内安装的工具链等运行时状态。

待决问题：

- **挂载固定**：常驻容器必须一次挂上该 Agent 的全部 roots；grant 撤销/过期/新增如何换代？换代窗口内旧挂载是否仍可读？与此前文档"多个 grant 在一次 action 中映射到 `/workspace`、不是同时挂载"的表述如何统一？
- **持久状态边界**：容器可写层活到换代还是跨重启？是否增加受容量校验的持久 scratch volume？workspace 已有 ext4 loopback 持久化。
- **idle 策略**：空闲后 `stop`（保留层、启动约 150 ms）还是 `retire`？资源上界如何计入部署 plan？
- **并发**：`maxBackendOperations` 是否从全局 1 放宽为每 Agent 1？
- **镜像升级、overlay2 容器层磁盘回收、review seat 是否继续用一次性容器。**
- **验收需覆盖**：跨 Agent 隔离、撤销 grant 后换代、exec 取消、daemon 崩溃收养/重建、OOM/ENOSPC、ncDE 原生基准。

### F1.3 常驻沙盒的进程终止语义

Docker `exec` 客户端被杀不会终止容器内进程。ncDE 原生复现：容器内启动 `setsid sh -c "sleep 300" &`，`timeout 1 docker exec <container> sleep 300` 杀掉 CLI 客户端后，`docker exec <container> ps` 仍显示 `sleep 300` 存活。当前 per-op 模式靠 `rm --force` 规避；改为持久容器后该保护消失。

需要做到：每次 exec 以独立进程组/session 运行并持久记录 pgid；abort/timeout/owner stop/daemon 关闭时终止对应进程组，未确认终止时保守处理（回执 unknown + 阻断/熔断）；daemon 崩溃重启后清理遗留 pgid，并决定容器收养还是重建；明确后台进程是否算受支持能力。

待决问题：pgid 记录写在哪（journal 还是 action receipt）；杀不掉时是熔断 backend 还是回收整个容器；收养时如何验证容器身份（label/image/generation/挂载/资源）。

### F1.4 目标机能力：ncDE 无 KVM，microVM 类排除

ssh ncDE 只读侦察：`systemd-detect-virt` = `kvm`（机器本身是 KVM guest）；`/dev/kvm` 不存在；`/proc/cpuinfo` 无 `vmx`/`svm`；`lsmod` 无 kvm 模块。无嵌套虚拟化 ⇒ Firecracker / Kata / libkrun / RustVMM 一类 microVM 后端（microsandbox、CubeSandbox、E2B Embed 等）在该机上无法运行。

影响：后端只能在"容器（含可选 gVisor）"与"进程级（bubblewrap/nsjail）"之间选择；更换 VPS 或使用裸金属时需重新检查 `/dev/kvm`。

### F1.5 备选路线：bubblewrap

事实：ncDE 上 `kernel.unprivileged_userns_clone=1`，`kernel.apparmor_restrict_unprivileged_userns` 不存在 ⇒ userns 前提成立；`bubblewrap` 未安装，apt 候选 `0.12.0-1~deb13u1`。Codex 和 Claude Code 在 Linux 上以 bubblewrap 作为默认沙盒底座（保护宿主不被单个 agent 破坏，不是多 Agent 互隔离）。

与持久 Docker 的主要差异：

- 挂载每次启动重算 ⇒ 权限收回立即生效，无需 generation 换代；但没有 `docker exec` 式 attach，进程状态/后台进程要么不支持，要么自建 in-sandbox supervisor。
- 默认共享宿主 `/usr` 等工具链（除非自建 per-Agent rootfs/overlay）；无隐式可写层，持久状态必须显式 bind。
- 无 dockerd/镜像/容器层，部署更轻；网络用 `--unshare-net` + 宿主代理（Unix socket/端口）实现默认断网与域名 allowlist；资源限制需要 cgroup/systemd-run 包装。
- 多 Agent 互隔离需要独立验证（uid + 各 namespace + /proc、setuid、宿主路径细节）。

待决问题：是否安装 bubblewrap 并在 ncDE 上做对照基准（启动延迟、node helper、shell、cgroup kill）；是否接受"沙盒状态=文件系统、无后台进程"；工具链共享宿主是否可接受；是否值得维护第二个后端。

---

*最后更新：2026-09-22。新增发现请沿用 F# 编号并写明证据来源。*
