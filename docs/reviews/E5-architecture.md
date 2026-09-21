# E5 工作能力架构设计 — PASS

日期：2026-09-21。独立只读红队：`/root/review_e5_architecture`。范围：`docs/ARCHITECTURE.md` E5设计、`docs/IMPLEMENTATION_PLAN.md` E5a/E5b及实际Environment/ToolRouter/Broker/附件/成果/研究/配置代码。此结论仅允许进入E5a，不代表代码gate通过。

初审不通过，四项P1代码前阻塞：pure-read `environment.info`会通过provision写grant；环境服务可能复制Broker授权判断；workspace label/重复root/旧配置迁移未闭合；adapter availability缺少actor/target范围且artifact可能冻结后才失败。另纠正了“下载失败一定无文件”对Broker unknown不成立。两项P2是`/workspace`与公开相对路径混淆，以及能力矩阵可能退化为关键词镜像。

修订后复审PASS，无遗留P0–P3。接受的实现硬条件：

- `WorkspaceAccess`在run交给模型前或`works.select`事务内原子provision；environment查询不写库、不写audit。
- Broker执行与`effectiveGrants`共用同一scope/effectiveness predicate；旧报告不是授权token。
- daemon与offline migration共用workspace profile规范化；label保留前缀、重复root合并规则、碰撞、旧v2序列化与policy hash均fail closed或显式迁移。
- review seat只暴露clean private workspace，并把联网、known-URL读取、附件与成果adapter报告为不可用。
- 窄port提供无副作用preflight；artifact在读取/冻结前按actor+target拒绝不支持路径。
- DTO区分relative-to-grant参数与exec内部`/workspace`；availability只表示配置/支持范围，不冒充实时健康。
- Broker写入unknown保留durable receipt并要求核实，不能声称目标未变化或盲重试。
- E5b能力矩阵关联真实ToolSpec、Zod DTO、system baseline、权威状态/无receipt语义与正式ToolRouter场景。

最终处置：架构gate PASS，可以实施E5a。代码完成和检查后仍须由未参与实现的独立红队审核。
