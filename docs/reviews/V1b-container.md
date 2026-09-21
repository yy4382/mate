# V1b Linux统一容器隔离 — PASS

日期：2026-09-21。基线：`b955be4`。独立只读红队：`/root/review_v1b_container`，未参与实现。范围：固定容器文件helper与命令执行、资源限制、启动探针、异常清理与熔断、恢复顺序、Docker控制面路径和正式Daemon接线。

实现结果：Linux部署时，结构化文件操作和命令执行使用同一个`ContainerBackend`，每次操作创建只读、去capability、`no-new-privileges`、无宿主环境继承的短生命周期容器。配置约束memory/cpu/pids/tmpfs，默认禁网；文件helper固定从应用构建产物只读挂载，不从Agent workspace加载代码。创建、启动或清理结果不确定时backend熔断，只有取得daemon锁后的显式scope恢复能解除。启动probe实际验证helper读写、越界拒绝、文件清理、PID namespace和容器清理，失败时不会打开Slack。macOS开发环境继续用SRT处理结构化文件，但真实Docker路径使用相同exec、probe和恢复协议。

红队三轮共发现并修复以下阻断问题：

- create抛错或非零返回后，`rm`报告容器不存在曾被当作已确认清理，可能在创建结果不确定时继续接收工作。现在只有create明确返回0才允许missing cleanup；其他情况熔断。
- workspace grant曾可包含Docker binary/socket或宿主伪文件系统，Agent可能触达执行控制面。现在策略集中于`daemon/paths.ts`，同时保护配置路径和物理路径，以及`/proc`、`/sys`、`/dev`、`/run`、常见凭据目录和systemd credential目录。
- Slack bot secret曾在container scope恢复前加载。transport改为延迟严格配置；startup先完成scope恢复、probe和本地恢复，再读取model/Slack secrets并启动adapter。
- 初次生命周期修复仍在DB、workspace和adapter构造之后恢复scope。现在使用异步`Daemon.create`：取得singleton锁后先恢复container scope，再构造Store和应用服务；DB policy或workspace检查失败也会回滚并释放锁。
- 上述factory一度在控制路径重叠检查前执行配置的Docker binary，恶意private/configured workspace脚本可先在宿主执行。现在任何Docker调用前进行无副作用控制面预检；恶意marker用例确认拒绝发生在执行之前。测试也在每例恢复mock，避免顺序造成假阳性。
- factory一度在constructor成功前转移锁所有权，recover后路径变化可泄漏锁。现在只在完整构造成功后转移；失败路径使用幂等release。红队重放路径消失场景后可立即重新取得锁。
- 规范化Docker executable到固定realpath后，Docker Desktop CLI multiplexer需要保留`docker`进程名。spawn现在仍执行固定realpath，同时用受保护的原配置路径作为`argv0`；真实Docker复验通过。

最终独立复审重放恶意private/configured binary、symlink父路径、missing尾路径、control-path overlap、recover后构造失败和锁释放，未发现剩余P0–P2或V1b阻塞。`pnpm check`为355项通过、8项需显式真实隔离环境而skip；显式启用的本机Docker Desktop Linux VM与SRT测试8/8通过，覆盖跨root、secret、socket、network、background process、abort/timeout、scope恢复、helper语义和启动probe。`git diff --check`通过。

本gate没有声称完成原生Ubuntu/systemd或目标VPS验证；Docker Desktop提供真实Linux容器内核与daemon协议证据，但目标宿主的mount、容量、UID和服务管理仍属于V1c/V2。
