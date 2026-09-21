# V2d3 运维与Slack接线门禁

日期：2026-09-22。实现：`/root/review_e2c2a_projection`与主Agent。独立只读红队：`/root/review_e2b2b_storage`，未参与本模块实现。本文先记录本地代码门禁；真实ncDE演练完成前，V2d3整体仍未通过。

## 本地实现

`matectl status`只组合固定`mate.service` ActiveState、平台中立OperationsView的计数和deployment/root/restore journal的内容无关进度。`matectl logs`不读取journald，只列最近24小时最多100条固定runtime/internal-DM事件名与时间。两者不接受参数、unit、路径或journalctl选项，不加载secret环境、不构造Daemon/Store、不迁移/recover、不联网；数据库用readonly连接和query-only事务读取。输出由字段白名单构造，不返回Agent、session、run、action、output、conversation、文件或配置标识和正文。

Slack SDK方法、事件订阅、运行时Bolt handler和`/team` command使用同一能力注册表；manifest由该表生成bot scopes和events，并单独说明app-level token只需`connections:write`。每位Agent使用独立App/bot/binding。生成器限制App名长度与bot名字符，启用可写Messages tab和Socket Mode。release manifest也通过正式deployment CLI生成，runbook要求目标Node/ABI上的完整`pnpm install --frozen-lockfile`、测试、production依赖安装和content inventory，不提供裁剪依赖路径。

## 本地红队

首轮发现两项P2交付阻塞：`pnpm run`标题会污染重定向JSON；生成的App/bot名称越过Slack官方长度/字符约束。修复为重定向命令统一`pnpm --silent run deploy`并实际解析stdout，以及Agent ID最长30字符、严格小写`mate_<agent>` bot名。独立复跑六文件47/47通过；本地最终完整测试455通过、10个环境跳过，typecheck/build与diff检查通过。红队结论是本地代码与文档PASS，无剩余P0/P1/P2。

## 尚待原生验证

ncDE须使用标准Node 24、pnpm 10.33、完整源码依赖安装和正式installer验证systemd/service-user、status/logs、无凭证不外联、candidate/rollback、activate失败不可逆、fix-forward、finalize controller、重启与恢复，并在结束后恢复原有目录、账户、unit、mount、loop与临时文件。真实Slack/provider凭证未提供时，只能确认生成配置与协议边界，不能宣称外部连接已验证。
