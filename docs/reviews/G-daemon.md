# G — daemon 与日用验收（PASS）

基线 `4fc849f`。范围：`src/daemon/`、`src/main.ts`、`tests/daemon/`、配置/README；v6 schema、requireWork调度过滤、ToolRouter research/artifact接口、Supervisor effect drain、receiver commit回调与nested team校验、文件runner IPC lifeline。

已完成本地 checks：68普通测试通过，4个真实隔离测试默认skip。合成完整Pi双Agent流程包含可见委派、独立反证、等待释放、任务结果驱动修订，统一预算；并覆盖未知peer echo、管理幂等、内核锁、备份恢复、research本地地址拒绝、未知成果上传不重放。真实服务未调用。

新增 `fs-ext@2.1.1`（类型2.0.3）用于内核flock：避免stale PID删除竞争，进程崩溃自动释放。容器scope只针对本dataDir；文件helper额外IPC lifeline避免daemon死亡后继续运行。

能力边界：研究工具是allowlist URL读取，无全网搜索API；成果仅自身artifacts/下64KB文本；Slack历史本地缓存有gap记录，非全workspace搜索；Jev影子模式。真实Slack/模型/Jev及真实任务质量仍待凭证验收。

独立红队 `/root/review_g`（fresh context、read-only）已PASS；最后私有memory项目grant拒绝规则经同一reviewer补充复核，独立运行68 passed / 4 skipped，维持PASS。无剩余验收阻塞。

## 独立审核发现、修复与复审

- P1：撤权频道pending审批通知使整轮daemon tick退出。通知按当前ACL隔离，已存在通知不重复建单；新增回归。
- P1：前20条paused work或未来retryAt占满发送批次。Output.ready查询先过滤，后选择批次；后续活动work不再饥饿。
- P1：启动await与shutdown释放锁竞争，进一步暴露SDK未连上时start Promise可长期等待。统一start/close Promise，先stop已建apps再等待start；ManagedSocket设置HTTP lifetime取消、30秒start上限、connecting迟到清理。独立复核实际SDK实现，延迟URL真实SDK离线fetch回归通过。
- P1：backup使用未canonical dataDir生成容器scope。统一executionScope(realpath)，alias父目录回归通过。
- 验收缺口：离线关注线程回复原仅靠history补抓。新增replies分页、每个thread独立cursor与gap记录，合成离线reply回归通过。
- artifact路径穿越（作者同时发现/修复，reviewer复核）：先解析规范相对路径，再要求落在自己的artifacts/，拒绝artifacts/../MEMORY.md。
- 非阻塞建议也已修：unknown输出采用rowid轮转；DNS等待通过AbortSignal race取消，避免占住drain。
- 真实回归暴露IPC lifeline让正常runner保持引用：finally注销disconnect回调并主动disconnect，恢复正常退出，同时保留daemon死亡连带终止。
- 追加：配置workspaceGrant不得覆盖任何Agent memory树，own-memory隐式read/write授权独立提供。

## 证据边界

reviewer核验SocketMode envelope与filesUploadV2实际SDK回执层级，并在最后补充复核中独立运行68 passed / 4 skipped。新增真实daemon死亡测试和私有grant边界回归均已纳入最终工作树。

实现者真实运行：原3项SRT/container测试全部通过（12.37秒），额外daemon SIGKILL→阻塞FIFO助手终止通过（约0.96秒）。独立reviewer本轮未重跑这4项真实隔离测试；E模块已独立复核过原3项隔离行为。

本地CLI `check mate.example.json` 正确报告两个模型目录项已知，但Slack/model环境变量缺失，Jev未配置、容器示例未配置。退出1是预期fail-fast，没有联网认证或发消息。
