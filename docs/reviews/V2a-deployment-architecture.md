# V2a deployment architecture review — PASS

日期：2026-09-21。独立只读红队：`/root/review_v2_architecture`，未参与设计。范围：Debian 13目标机、release/config/data/backing/systemd分层、专用service账户的Docker控制、mount units、维护入口、checkpoint/restore、升级/回滚与Socket Mode接线。

初审阻塞包括：空目标restore无法支持升级回滚；跨多个ext4根用内存式清理冒充原子；external workspace可能被误清空；共享external root与deployment spec冲突；现有配置不允许删除Agent；doctor会并发清除scope；root与mate身份无法同时满足workspace和Docker；DB迁移与配置文件切换存在崩溃窗口；安装中断会留下不可复用的稀疏/半格式化backing；mount命名、owner、ordering和停用语义不足。

第二轮补充发现checkpoint hardening路径冲突、硬容量root无法同时容纳old/new staging，以及topology改变后旧checkpoint、manifest和unit无法直接回滚。第三轮进一步阻止candidate在外部激活后用旧checkpoint回滚，因为那会丢失Slack/provider副作用的receipt与ingress去重；同时要求checkpoint在decision后保持真正不可变。

最终设计使用内容身份release、同目录事务staging、唯一external root spec、固定topology首版、systemd-escape mount、明确root/mate权限、被动doctor与离线probe、root allowlist wrapper+systemd-run维护身份、独立只读checkpoint root、root封存inventory、control journal、decision前零修改/decision后单向可重入restore，以及完全非活动candidate和不可逆activate边界。升级激活后只允许fix-forward或明确兼容的code-only rollback，不自动把数据库恢复到外部副作用之前。

结论：无剩余P0/P1，V2a PASS。实现期P2：完整目录fsync与symlink语义；release identity含arch/Node ABI/native addon hash；decision后repair保持source identity；activated失败保留journal供诊断。该结论不代表V2b–V2d代码或目标机演练已通过。
