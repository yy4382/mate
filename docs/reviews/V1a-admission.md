# V1a 运行与执行 admission — PASS

日期：2026-09-21。基线：`f211ddd`。独立只读红队：`/root/review_v1a_admission`，fresh context，未参与实现。范围：进程内run/backend资源准入、等待取消、worker idle回收、部署配置、旧policy迁移和正式Daemon接线。

实现结果：生产默认全局同时1个active run和1个backend operation。`FairAdmission`提供FIFO、有界、可取消的进程内槽位；durable delivery、task、reminder和session继续由SQLite保存。停止Agent或关闭daemon会撤销等待，执行失败释放槽位。private memory recovery与Broker的文件/exec路径共享同一backend admission。worker在最后一次真实run结束后的有限TTL关闭，500ms空轮询不重置期限。`check`回显生效限制，示例配置使用低配默认值。

红队初审发现并修复两项P1和两项P2：

- 取得run槽后，account/beginRun前置异常曾位于释放用的`finally`之外，可永久占用唯一槽。现由外层`finally`覆盖取得槽后的全部返回和异常路径，并回归验证重复异常不泄露或双重释放。
- 新增默认limits改变旧runtime policy hash，而parser会补默认值，导致旧库既不能启动也不能迁移。在线启动仍明确拒绝policy变化；离线迁移会对持久配置的原始runtime进行语义等价和精确hash核对，只在limits等于新增默认值时接受pre-limits精确形状。不同researchHosts等其他policy仍拒绝。迁移后保存新policy并可启动。
- recovery曾直接调用裸文件backend，绕过全局backend上限。现与Broker backend共享同一个admission，且每条路径只取得一次槽位。
- 配置曾允许`workerIdleMs:0`并将其解释为永不回收。部署schema现只接受1–3600000ms；默认300000ms。

复审重放原始问题并检查budget/no-work、beginRun、主体异常、stop/shutdown、AbortSignal、timer、迁移兼容范围和双重acquire，未发现剩余P0–P2或验收阻塞。`git diff --check`、类型检查、21项定向测试通过；完整普通集340项通过，7项需显式真实隔离环境而skip。V1a PASS；尚未实现或声称V1b Linux统一容器隔离与V1c workspace容量边界。
