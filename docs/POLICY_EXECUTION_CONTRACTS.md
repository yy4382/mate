# 权限与执行边界

E 的身份和 work 来自 daemon 绑定的 RunToken；grant 由配置 owner 创建。文件、目录与 shell 使用相同 broker，不能通过 write/read 绕过执行边界。应用目录、中央状态、其他 Agent 私有根必须由启动配置传入 protectedRoots，不能对重叠目录签发 grant。

- read/write 在持久有效 grant 范围内执行。目录遍历和 symlink 被拒；OS sandbox 是执行时路径隔离边界。
- shell 默认具体持久审批。owner 可以预授权精确 command/cwd 与已核对脚本哈希，使测试等已授权命令可持续运行；变参/manifest 或 literal node/sh/python入口脚本变化使预授权失效。动态依赖未完全冻结，不声称哈希能证明任意shell行为。
- Jev 使用官方 TypeSafe 0.6.0、固定jev-1.13.0、总deadline、关闭SDK日志与重试、清除已知秘密。尚未真实校准，因此结果只作shadow审计；不可用不改变权限。
- approval 固化 action/hash/grant/policy/期限；非owner不能决定，重复点击幂等，consume与executing事务提交。审批pending在DB阻止本run后续动作；工具返回结构化等待，F应在完整工具轮后释放通道。
- grant撤销/失效、参数或核对脚本变化都会阻止执行。持久action收据可重读，unknown不自动重放。
- macOS开发环境的文件操作使用独立SRT进程；Linux部署的结构化文件工具与shell使用同一ContainerBackend。两者都不启用不受限fallback，配置无法建立即失败。
- 结构化文件工具在隔离后端内运行，写入临时文件/fsync/rename，保留最多5版history。读取最大64KiB，写入最大1MiB。
- 任意shell由ContainerBackend执行，SRT拒绝exec。每次独立PID namespace，镜像固定sha256且不自动拉取，唯一host挂载为授权root→/workspace，network none、read-only rootfs、无capabilities、no-new-privileges、资源配额。超时/abort/正常结束均等待强制删除容器后才返回，覆盖setsid脱离进程。删除失败报告unknown，不声称停止成功。Docker日志关闭。
- 容器有daemon scope标签。启动获取单实例锁后recover只清理同scope孤儿容器，再恢复业务；不能清理其他scope。Linux随后验证workspace manifest中的每个私有/外部root都是不同设备上的`ext4` loopback mount，backing file已预分配且容量、owner和mount identity一致；失败时不创建普通目录、不接Slack。

## 验证范围

普通check为mock执行器和SDK传输；真实沙箱需先build，然后提供MATE_DOCKER_IMAGE（本地镜像sha256）、MATE_DOCKER_HOST（unix socket）和可选的MATE_DOCKER_BINARY（默认`/usr/local/bin/docker`），运行 `MATE_SANDBOX_TEST=1 pnpm exec vitest run tests/execution/sandbox.test.ts`（项目Node 24 PATH）。2026-09-21在macOS+本地Docker实际验证自有文件读写、兄弟目录读写拒绝、环境秘密不继承、本地HTTP出站拒绝、setsid正常/abort/timeout后无残留写入。SRT代理socket与Docker socket需外层环境允许。

未验证Linux/Windows或真实Jev分类/延迟。当前网络deny-all，后续研究工具应有独立受控网络适配器；不能用无限制shell补足。容器镜像需具备实际任务的工具链；本地busybox测试不表示Node/Python工程镜像已配置。
