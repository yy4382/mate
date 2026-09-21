# E5a 当前工作环境能力 — PASS

日期：2026-09-21。基线：`a60ed96`。实现后独立只读红队：`/root/review_e5a_capabilities`，未参与实现。范围：workspace profile/provision、Broker有效grant判定、`mate.environment.v1`、actor/target adapter preflight、daemon/migration组合及回归测试。

实现结果：`WorkspaceAccess`在Supervisor把run交给模型前原子准备全部配置grant，`works.select`在同一action事务中准备新work；`environment.info`保持pure-read。Broker执行和环境查询共用run/work/ACL/revoke/expiry/root/review-seat判定。workspace profile合并canonical重复root、拒绝label歧义，缺label的旧v2配置保持原序列化/policy hash，显式label走离线迁移。环境DTO只给opaque grant、label、operations与限制，不给宿主root、socket或secret。

红队初审发现并修复三项P1：

- 只按actor报告artifact会在internal work上虚报可用；改为无副作用的actor+current-target supports。
- 最后一个exec grant失效后仍显示bridge；现无有效exec+image即`unavailable / network:none / image:null`。
- workspace运行中消失会把Node FS错误中的宿主路径返回模型；Broker共享判定统一fail closed为固定无路径错误。

红队用`/tmp`独立反例复验3/3通过，并独立复跑environment、Broker、migration、attachments与tool modules 39/39。实现者最终`pnpm run check`：46文件通过、1文件按条件skip，323项通过、7项真实隔离按环境skip；`git diff --check`通过。

工程结论：依赖仍是core窄port与daemon composition；环境报告不成为第二授权源，不缓存grant，不探测或冒充adapter健康；review seat只见clean private workspace，联网/known-URL/附件/成果均隔离；artifact在文件读取/冻结/draft前预检并在冻结后再检。无遗留P0–P2，E5a PASS，可以进入E5b。
