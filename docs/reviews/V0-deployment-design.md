# V0 — VPS首版部署设计

状态：PASS。独立只读reviewer `/root/review_v0_deployment`，fresh context，检查实际执行/调度/备份代码后两轮讨论。没有需要用户裁决的关键分叉。

原6项设计阻塞：Linux文件隔离路径与启动探针、运行/闲置worker/磁盘全生命周期资源约束、Docker清理未确认及systemd强杀恢复、symlink与外部grant备份范围、真实Linux/systemd验收层级、可信worker与不可信工具执行边界。

修订见ARCHITECTURE末V0契约：Ubuntu24.04 x86_64；Linux固定helper经Docker；启动实际probe；默认1run/1exec、公平admission及idle回收；每Agent有界ext4挂载；cleanup未确认熔断unknown；离线symlink本体备份、同路径干净VM恢复；明确可信代码边界。复审全部设计阻塞解决。

V1/V2必须落实：loopback文件实际预留宿主空间，禁止稀疏文件冒充容量保证；挂载缺失不能回退普通目录，核验挂载身份/容量。helper共用资源/cleanup/fuse，不继承宿主env或从workspace加载代码。恢复拒绝部分/损坏备份，在确认目标挂载后恢复且不跟随symlink。

仅设计通过；未运行/声称Linux隔离、systemd安装和恢复通过。后续模块必须独立实现与审核。
