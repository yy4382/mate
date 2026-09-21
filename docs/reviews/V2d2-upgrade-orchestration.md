# V2d2 root升级编排门禁

日期：2026-09-22。实现：`/root/review_e2c2a_projection`与主Agent。独立只读红队：`/root/review_e0_architecture`，未参与本模块实现。范围是固定root staged输入、离线candidate、checkpoint rollback、不可逆activate、fix-forward、finalize，以及root与service-user之间的权限和恢复边界。

## 实现结果

root编排使用固定路径和独立运维锁，持久化root journal后停止service，再依次绑定并封存rollback checkpoint、写deployment journal、发布不可变release、执行带attempt marker的离线迁移、原子发布config/current并执行doctor/offline probe。candidate不构造Daemon或Slack/provider transport，也不启动service。activate先持久记录`everActivated`再启动；此后旧checkpoint回滚永久拒绝，只允许同一upgrade内fix-forward。

`/opt/mate/controller`保存last-known-good恢复控制器。checkpoint、restore和restore收尾只执行controller；migrate/probe才执行candidate。candidate checkpoint直接使用SQLite backup API，不构造Store或迁移未知schema。release manifest绑定`recoveryProtocol`，不兼容候选在改变数据库前拒绝。finalize再次验证候选，原子推进controller，确认父目录持久化后才清除journals；`resume`可恢复controller发布的每个中断点。helper固定路径移入独立layout模块，避免恢复helper运行时依赖host/orchestrator。

fix-forward保留原upgrade ID、原rollback checkpoint和不可逆激活事实，每次迁移使用新attempt。未提交的B→C只有在无C marker且数据库配置仍为B时才能被B→D替换；已提交C必须先完成C发布，再以C→D继续。activated current即使内容损坏，也能从journal、config/current位置和数据库证据进入新候选，不执行损坏版本。

## 红队发现与修复

首轮BLOCKED，P1两项：candidate rollback的checkpoint/restore仍执行next release；`prepare`无条件验证损坏的activated current，导致不可回滚又无法fix-forward。进一步指出只改成previous仍会因Store构造迁移新schema，并且首次安装release不能永久担当未来控制器。修复为独立controller、原始SQLite snapshot、显式recovery protocol和finalize推进controller。

复审中又发现`finalizing`经普通resume会跳过controller发布，以及finalize曾先发布controller再验证candidate。均改为先验证，持久发布controller，再清journal；finalizing resume执行相同序列。独立复审最终P0=0、P1=0，PASS。红队实际复现坏release与finalize中断，并额外验证三个controller发布边界及损坏candidate不得替换controller。

## 验证

本地类型检查、完整测试、聚焦升级/迁移/checkpoint/部署测试和diff检查通过。覆盖release/config/current/controller的rename/fsync中断、源替换、迁移提交两侧、rollback恢复、activate启动失败、连续fix-forward、未提交attempt替换、坏activated release、未知DB schema原始snapshot及helper release路由。真实systemd、mate UID/GID、标准Node/pnpm安装和VPS清理属于V2d3 gate，不由本地PASS替代。
