# V1c workspace容量与启动边界 — 代码PASS，原生环境验收待完成

日期：2026-09-21。独立只读红队：`/root/review_v1c_workspace`，未参与实现。范围：部署workspace manifest、ext4 loopback身份与硬容量验证、Linux启动失败关闭、运行中mount重验、Docker/宿主同一workspace探针、迁移/备份边界和Agent环境容量报告。

代码结果：Linux配置容器执行时必须提供root拥有的workspace manifest；它精确覆盖每个Agent私有root及每个外部grant root。构造Store、写Agent文件和连接Slack前，验证器要求每个root都是独立、非嵌套、daemon拥有的`ext4` loop mount，带`rw,nodev,nosuid`，backing file路径及inode不复用、实际非稀疏且容量匹配。每次文件/命令操作重新验证边界，并与启动身份比较；卸载、替换manifest/backing/device或权限变化会失败关闭并要求重启。启动探针对所有root执行宿主与容器双向nonce，拒绝Docker daemon处于不同bind namespace，失败路径也清除容器侧nonce。

红队多轮发现并修复：嵌套root可借父bind看到同伴挂载、backing file可复用、探针只验证单root且不能证明宿主/容器同源、manifest缺少可信读取与TOCTOU防护、迁移/备份未共用验证器、运行时合法替换manifest会使能力报告漂移，以及不同namespace探针残留nonce。最终实现拒绝overlap与相同canonical path/`(dev,ino)`，用`O_NOFOLLOW`单fd前后`fstat`读取root-owned manifest，对全部root做双向探针，启动身份发生变化要求重启，并在启动、迁移、离线backup和在线checkpoint复用同一验证边界。

原生试验还暴露两个部署契约并已进入代码、文档和回归测试：非root daemon读取的manifest应为`root:<mate service group> 0640`；`mkfs.ext4`可能discard先前的预分配extent，因此部署顺序必须是`truncate → mkfs.ext4 → fallocate`。64 MiB最小ext4会因元数据使`statfs`总数据块低于旧90%阈值，验证器改为在精确非稀疏backing和sysfs loop identity硬上限内允许`max(10%, 16 MiB)`元数据差额；55 MiB代表值、48 MiB边界及少一个4096字节块拒绝均有持久测试。

验证：`pnpm test`为373项通过、8项显式真实容器环境skip；定向deployment/container/migration为33项通过；本机真实Docker隔离组8/8通过；`git diff --check`和TypeScript build通过。独立红队最终判定代码与测试gate PASS，未留P0/P1/P2。

在Debian 13目标机复跑时，旧策略兼容测试暴露了宿主平台隐式依赖：它在Linux上会先正确触发“容器配置必须有workspace manifest”，因而无法到达自己要验证的旧hash迁移。修复只让该测试显式使用macOS开发环境契约并使用独立project目录；相邻Linux测试仍验证无manifest时迁移在备份和持久化前失败。`/root/review_v1c_workspace`复审实际diff并独立复跑11/11，判定PASS且没有P0/P1/P2；本地完整测试仍为373项通过、8项环境skip。

同一目标机的完整测试随后又找出5个daemon集成用例依赖测试宿主平台。它们验证container recover/probe与Slack启动顺序、失败先后、控制路径隔离和grant升级，不验证Linux managed workspace，因此现在统一显式注入unmanaged macOS开发契约；所有带Docker的相关`Daemon.create`调用均已显式化。Linux缺manifest、有效manifest、全root探针和逐操作重验仍由显式Linux部署测试承担。该增量经同一独立审查者核对实际diff并复跑integration+workspaces 48/48，判定PASS，无P0/P1/P2。

最终V1c gate仍未标PASS：必须在Ubuntu 24.04 x86_64原生宿主完成真实预分配ext4 loop mount、ENOSPC、mount丢失失败关闭和重启恢复。中途QEMU环境仅用于发现上述问题，未形成完整验收；相关VM、镜像、overlay、seed、密钥、运行库、端口和临时容器已全部清理。更新后的OrbStack 2.2.3 `ubuntu` machine仍处于`creating`，待其可用后只用标准OrbStack路径完成剩余证据。V2 restore对预先挂载root的适配仍是下一模块范围。
