# V2b checkpoint v2 与 managed restore — PASS

日期：2026-09-22。独立只读红队：`/root/review_v2b_checkpoint`，未参与实现。范围：checkpoint v2格式与生成、root封存、managed/unmanaged恢复、恢复journal、迁移边界、容量证明、原生故障演练和旧v1兼容。

实现结果：checkpoint v2记录配置、数据库和每个Agent私有root的内容身份、逻辑/分配大小、mode、symlink本体及容器镜像，并显式排除external grant和控制文件。备份只在daemon停止并持有锁时创建，先截断WAL，再以nofollow文件描述符读取；特殊文件、硬链接、越界checkpoint和不完整目标会失败关闭，`COMPLETE`只在完整验证后发布。

managed checkpoint先要求整个候选属于service UID/GID且mode精确，再由root维护入口持锁，自顶向下用`O_NOFOLLOW | O_DIRECTORY`打开目录，通过`fchown`、`fchmod`和`fsync`封存为`root:service-group`只读树。CLI显式接收预期UID/GID，并核对data目录和现有daemon lock身份；生产API不接受可注入的宿主权限参数。

恢复在打开Store或Docker之前执行。它验证Linux workspace topology，隔离并恢复容器控制面，然后通过位于外部checkpoint的持久journal完成跨多个私有ext4 root和SQLite的单向roll-forward。decision前不修改当前数据；decision后逐Agent恢复，数据库最后切换。journal绑定checkpoint和当前状态身份，支持实际SIGKILL后的幂等续作；source被替换或篡改时保持债务并拒绝继续，修复为同一身份后可以续作。容量按每个独立filesystem的可用block/inode以及数据库逻辑/分配量校验，已完成的数据库切换不会因第二次容量检查死锁。managed topology迁移被旧迁移入口拒绝；unmanaged v2和v1仍可从空data目录恢复。

红队初审发现并修复了多项P1：封存所有权和父目录契约不足、封存后序遍历存在symlink换入窗口、CLI从可变data目录推导group、生产接口可伪造宿主身份、managed迁移可能先改配置再备份、恢复前未隔离Docker控制面、unmanaged v2无法恢复、SIGKILL/ENOSPC证据不足，以及数据库已经完成但journal尚未落盘时的容量死锁。原攻击与故障复现均已反转；失败checkpoint清理按设备/inode约束且生产路径只接受真实root权限。

原生验收在`ncDE`完成，使用标准冻结lockfile的`pnpm install --offline`和项目build，没有裁剪依赖或拼装运行时。三个真实64 MiB ext4 loop mount分别承载两个Agent私有root和一个external root。场景覆盖root封存、near-ENOSPC decision前拒绝、第一Agent切换后实际SIGKILL、重启续作与数据库最后切换、decision后source篡改拒绝及同identity修复续作，以及external sentinel不变。目标机和本机全量测试均为386项通过、10项显式环境skip；typecheck与`git diff --check`通过。

独立红队最终判定P0=0、P1=0，V2b PASS。保留一个非阻塞P2：`restore.ts`和`checkpoint-format.ts`的部分安全关键状态机仍较压缩；V2c/V2d触碰这些路径前应只做保持行为的分段重排并复跑既有回归，避免在部署变更中混入语义修改。

验收后已删除ncDE上的候选、原生运行目录、loop/mount/backing及本地传输包；`/opt/mate/current`仍指向原有`/opt/mate/releases/11e520d`。
