# 自动部署测试

> 自动部署脚本的设计见 [DEPLOYMENT §5.5](../../docs/DEPLOYMENT.md)。共用的测试规则见 [docs/MODULE_TESTS.md](../../docs/MODULE_TESTS.md)。

**边界：** `deploy/auto-update/palace-deploy`（DEPLOYMENT 5.5），从它的命令行和标准输入驱动，只看部署后机器上的状态：`.env` 里的镜像、node 装的版本、数据目录的内容、node 服务是否在运行、备份和留下的发布包。`deploy/auto-update/test.sh` 在干净的 x86_64 Debian 13 容器里以 root 跑，CI 里是单独的 `palace-deploy` 任务。等待健康和等待 node 连上（`PALACE_HEALTH_WAIT`、`PALACE_NODE_CONNECT_WAIT`）的秒数在测试里调到 2 秒。

**替身：** `docker`、`curl` 和 `palace node` 是把"正在运行的版本"记在文件里的替身：`compose up` 起 `.env` 里的镜像并改写数据目录（像一次迁移），版本名带 `bad` 的控制面永远不健康，带 `nostart` 的 node 启动后服务在运行但 `status` 永远是 `Link: none`（连不上控制面）；其余版本启动后是 `Link: connected`。`runuser`、`flock` 和文件操作都是真的。

- 部署正在运行的版本什么都不改；`deploy <版本> <sha256>` 以外的命令被拒绝；标准输入的发布包和 sha256 不符时拒绝，什么都不改。
- 正常的新版本：镜像、node 版本都换成它，服务在运行，部署前的数据有一份备份。
- 控制面起来后不健康：镜像换回原来的，数据目录换回部署前的备份，node 仍是原版本并在运行，以失败退出。
- node 启动后一直连不上控制面（`Link: connected` 在等待时间内没出现）：打印 node 日志，同样全部回退，node 换回原来的发布包。
- 回退之后还能部署更新的版本；只留最近 `PALACE_KEEP_BACKUPS` 份备份和新旧两个发布包；每次部署都记进日志。
