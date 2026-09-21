# V1c workspace容量与启动边界 — PASS

日期：2026-09-21。独立只读红队：`/root/review_v1c_workspace`，未参与实现。范围：部署workspace manifest、ext4 loopback身份与硬容量验证、Linux启动失败关闭、运行中mount重验、Docker/宿主同一workspace探针、迁移/备份边界和Agent环境容量报告。

代码结果：Linux配置容器执行时必须提供root拥有的workspace manifest；它精确覆盖每个Agent私有root及每个外部grant root。构造Store、写Agent文件和连接Slack前，验证器要求每个root都是独立、非嵌套、daemon拥有的`ext4` loop mount，带`rw,nodev,nosuid`，backing file路径及inode不复用、实际非稀疏且容量匹配。每次文件/命令操作重新验证边界，并与启动身份比较；卸载、替换manifest/backing/device或权限变化会失败关闭并要求重启。启动探针对所有root执行宿主与容器双向nonce，拒绝Docker daemon处于不同bind namespace，失败路径也清除容器侧nonce。

红队多轮发现并修复：嵌套root可借父bind看到同伴挂载、backing file可复用、探针只验证单root且不能证明宿主/容器同源、manifest缺少可信读取与TOCTOU防护、迁移/备份未共用验证器、运行时合法替换manifest会使能力报告漂移，以及不同namespace探针残留nonce。最终实现拒绝overlap与相同canonical path/`(dev,ino)`，用`O_NOFOLLOW`单fd前后`fstat`读取root-owned manifest，对全部root做双向探针，启动身份发生变化要求重启，并在启动、迁移、离线backup和在线checkpoint复用同一验证边界。

原生试验还暴露两个部署契约并已进入代码、文档和回归测试：非root daemon读取的manifest应为`root:<mate service group> 0640`；`mkfs.ext4`可能discard先前的预分配extent，因此部署顺序必须是`truncate → mkfs.ext4 → fallocate`。64 MiB最小ext4会因元数据使`statfs`总数据块低于旧90%阈值，验证器改为在精确非稀疏backing和sysfs loop identity硬上限内允许`max(10%, 16 MiB)`元数据差额；55 MiB代表值、48 MiB边界及少一个4096字节块拒绝均有持久测试。

验证：最终`pnpm test`为373项通过、10项显式真实后端环境skip；定向deployment/container/migration通过；本机历史Docker隔离检查通过；`git diff --check`和TypeScript build通过。独立红队最终判定代码与测试gate PASS，未留P0/P1/P2。

在Debian 13目标机复跑时，旧策略兼容测试暴露了宿主平台隐式依赖：它在Linux上会先正确触发“容器配置必须有workspace manifest”，因而无法到达自己要验证的旧hash迁移。修复只让该测试显式使用macOS开发环境契约并使用独立project目录；相邻Linux测试仍验证无manifest时迁移在备份和持久化前失败。`/root/review_v1c_workspace`复审实际diff并独立复跑11/11，判定PASS且没有P0/P1/P2。

同一目标机的完整测试随后又找出5个daemon集成用例依赖测试宿主平台。它们验证container recover/probe与Slack启动顺序、失败先后、控制路径隔离和grant升级，不验证Linux managed workspace，因此现在统一显式注入unmanaged macOS开发契约；所有带Docker的相关`Daemon.create`调用均已显式化。Linux缺manifest、有效manifest、全root探针和逐操作重验仍由显式Linux部署测试承担。该增量经同一独立审查者核对实际diff并复跑integration+workspaces 48/48，判定PASS，无P0/P1/P2。

真实隔离套件原本把Docker CLI固定为macOS常见的`/usr/local/bin/docker`，无法在Debian标准`/usr/bin/docker`路径运行。套件现支持显式`MATE_DOCKER_BINARY`并继续保留原默认值，全部backend与直接scope核查共用同一binary。独立复审确认没有残留硬编码或静默跳过路径，代码gate PASS；目标机真实运行结果另记在最终验收段。

原生目标机验收在`ncDE`完成：Debian 13.7 x86_64、kernel 6.12.107、systemd 257、Node 24.21.0、pnpm 10.33.0、Docker 26.1.5。标准release `11e520d`安装在`/opt/mate/releases/11e520d`并由`/opt/mate/current`指向；冻结lockfile安装和目标机完整测试通过。官方`node:24-alpine`本地镜像ID固定为`sha256:c10884952bb8c37122fcc3fe6f97af3ab0a80e5eb02ee5df707406b4e11a7e3e`，Linux生产container profile为5/5通过，另5项macOS SRT profile按预期skip。

完整daemon以local adapter和合成provider secret启动，使用两个各64 MiB、真实预分配且互不复用的ext4 loop workspace；启动对两个root完成宿主/容器双向nonce、越界和namespace清理探针，并创建SQLite与独立Agent memory。80 MiB写入在55,988,224 bytes处得到真实ENOSPC；删除填充文件后空间恢复。卸载research mount后，同一完整启动路径在模型或adapter运行前以`Workspace mount must use a distinct filesystem`失败；重挂同一backing后重新启动成功，且没有遗留`mate.execution`容器。

验收专用mount、loop、backing、数据库、配置、临时bundle和失败release候选均已移除；只保留当前release与一个回滚release。QEMU试验遗留也已全部清理。V1c最终PASS。此次原生边界验收由root运行以验证mount/Docker内核契约；专用service account如何获得Docker控制能力、持久mount unit、systemd、backup/restore对已挂载root的适配仍属于V2，不能由V1c冒充完成。
