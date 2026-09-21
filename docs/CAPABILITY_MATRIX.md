# Harness能力、prompt与证据矩阵

更新：2026-09-21，E5b。这里把首个实验版的核心体验连接到实际公开工具、当前环境、持久状态和验证。它不是第二份运行时注册表：operation及schema以`builtInToolSpecs`/`tools.describe`为权威，环境以`mate.environment.v1`为权威，表格只说明这些机制组合后让足够智能的模型能够做什么。

| 可达体验与模型选择 | System prompt约定 | 公开operation | 环境/适配器条件 | 权威状态或回执 | 成功与失败证据 |
|---|---|---|---|---|---|
| 保持身份、恢复上下文、主动保存进度或换context | Starting and resuming；Workspace, knowledge and tools | `sessions.status/checkpoint/reset`、`actions.list/read` | 无平台依赖；私有workspace grant由run前准备 | session journal/snapshot/checkpoint/reset、action receipt | `runtime/supervisor.test.ts`：reset、压缩刷新、unknown跨session；`runtime/tool-modules.test.ts`：重放 |
| 自主选择读、暂缓、处理或沉默 | Starting and resuming | `attention.peek/read/resolve/defer/mute`、`inbox.*` | 当前conversation ACL；结果有coverage/cursor | delivery、attention event/seen/defer/mute；读取不等于处理 | `slack/attention.test.ts`、`slack/attachment-attention.test.ts`、`runtime/supervisor.test.ts`：notice不含正文、quiet path、分页ACK |
| 查本地/外部有界历史，不把局部结果冒充完整 | Starting and resuming | `history.page/search/around/fetch`、`messages.recent/read/search` | external fetch需要acting installation；internal按当前membership | canonical message、actor revision snapshot、coverage/gap；quiet fetch无delivery | `conversations/history.test.ts`：分页、空页continuation、撤权、per-installation snapshot |
| 在频道、thread或DM直接沟通，可联系同伴也可不发言 | Communication and submission；Purpose and initiative | `conversations.*`、`messages.send/watch`、`agents` | directory能力按adapter返回；内部DM无需Slack | outbox/draft、confirmation、message/delivery | `conversations/internal.test.ts`、`daemon/integration.test.ts`：直接协作、openDM、无task tree |
| 认领原消息、让位、移交、复核、等待依赖；普通讨论不强制task | Tasks and collaboration | `tasks.*`、`works.list/select` | 当前对象ACL；跨work变更绑定对象work | canonical task/version/event、task intent、work selection | `coordination/*`：claim CAS、peer review、intent多选择、dependency recovery |
| 安排自己的跟进并区分触发、执行和语义结果 | Tasks and collaboration | `reminders.*`、`schedules.*` | author私有；可选公开content-free receipt | reminder/event/firing/delivery/result各自持久 | `reminders/*`：private不唤醒peer、finish幂等、改期/取消/恢复 |
| 准确发现当前work能用哪些workspace与外部路径 | Workspace, knowledge and tools | `environment.info`、`works.select` | `mate.environment.v1`：effective grants、已验证硬容量、relative path、exec/network、known URL、input/output scope | 环境是pure-read快照，无action receipt；Broker每次重验 | `capabilities/environment.test.ts`：原子provision、撤销/过期/切work/seat、无Docker/adapter、路径不泄露；`deployment/workspaces.test.ts`：mount/capacity边界 |
| 组织私有知识、检查/编辑/移动/删除文件 | Workspace, knowledge and tools | `file.read* / write* / list / stat / search / mkdir / edit / move / remove` | 选择一个effective grant；参数相对grant root；Linux固定helper在短生命周期容器内 | Broker durable action；read/write receipt；unknown保守阻挡；cleanup fuse | `execution/files.test.ts`、`execution/container.test.ts`、`policy/broker.test.ts`：边界、hash CAS、资源、熔断、停止/unknown；真实helper见sandbox |
| 在固定工具链里运行命令，或准确报告没有执行/联网能力 | Workspace, knowledge and tools | `exec`、`environment.info` | effective exec grant + pinned image；network none/bridge；review seat强制none | Broker action/receipt；容器scope、资源限制、startup recovery/probe与cleanup fuse | `execution/sandbox.test.ts`：8项真实容器/SRT隔离、停止、网络、helper、scope；默认条件skip单列 |
| 读取一个已知且允许的URL；需要搜索时选择真实替代路径或报告缺口 | Workspace, knowledge and tools | `research.read`、`environment.info` | allowlisted public HTTPS；不是search；可替代为networked exec、人/peer提供URL、已有文件/历史 | pure read，无durable action receipt；结果进入当前tool journal | `runtime/tool-modules.test.ts`：正式Router、无action、stop/abort fence；`daemon/research.test.ts`：DNS/redirect/64KB截断/abort；`daemon/integration.test.ts`：local/metadata地址与URL凭证拒绝 |
| 把可见消息中的文件变成工作输入 | Workspace, knowledge and tools | `attachments.save`、文件工具、`actions.read` | actor attachment adapter；文件必须属于当前可见external message；有效write grant | download阶段无写；Broker write有durable receipt，unknown可能已改文件 | `daemon/attachments.test.ts`：认证下载、ACL撤销、大小/截断、正式Router保存与读取 |
| 把自身成果冻结、修改、知情继续并交付到支持的外部target | Communication and submission；Workspace, knowledge and tools | `artifact.publish/revise`、`drafts.*` | 环境区分actor adapter与current-work target；调用对实际显式target再次preflight；仅自身`artifacts/` | frozen artifact/outbox/draft、staging fileId/phase、sent/failed/unknown | `daemon/attachments.test.ts`：正式Router附件→文件→revise→send；`slack/freshness.test.ts`：staging、unknown对账、分享前重查 |
| 面对并发变化保留最终沟通判断 | Communication and submission | `attention.read`、`drafts.retry/revise/discard/continue`、`tasks.intents/retry/discard/continue` | current ACL/run/work；continue只跨freshness | immutable draft revisions、hold ID/expiry、task intent | `daemon/integration.test.ts`：defer/discard/continue/revise/retry五种路径；`slack/freshness.test.ts`：429/unknown/停止 |
| owner查看安全状态/activity并控制运行，不复制敏感正文 | Authority, independent review and resources（Agent只理解边界；owner接口不暴露给Agent） | Agent无owner activity工具；local/Slack control调用`OperationsView` | canonical owner principal | 权威领域表+窄operational facts/vector cursor | `operations/view.test.ts`、`daemon/local-runtime.test.ts`：owner认证、分页、敏感字段缺失、事务回滚 |
| 在独立review seat中只依据brief和clean workspace工作 | Authority, independent review and resources | 同一工具目录按seat policy过滤；允许clean workspace与held send | 无conversation/peer/research/attachment/artifact；exec network none | `review_seats`、独立session/draft；owner release | `runtime/supervisor.test.ts`、`policy/broker.test.ts`：输入隔离、恢复、grant与网络旁路拒绝 |

## 失败语义

- `configured`只表示路径和adapter已为该scope安装，不表示实时网络健康；真实调用仍可能失败并返回当前边界的错误/receipt。
- `environment.info`没有授权副作用，旧报告也不是capability token。撤销、过期、work切换、ACL变化、stop或review seat在下一动作重新检查。
- `research.read`失败不等于“搜索无结果”；本版没有通用search/browser。Agent可选用矩阵中实际存在的替代路径。
- attachment在认证、HTTP、大小或下载完整性失败时不会进入Broker写入；Broker开始写入后若outcome unknown，文件可能已经变化，必须先检查action与文件证据。
- artifact内容在publish/revise时冻结。修改源文件不更新draft；上传开始分享后unknown不得以新action ID盲重发，只能使用匹配的外部证据对账。
- 普通assistant文字不会离开私有上下文；对人或同伴可见的消息必须走`messages.send`或支持target的`artifact.publish`。

## 自动防漂移

`tests/runtime/tool-modules.test.ts`枚举每个公开operation一次，验证每项都有可解析schema与完整policy，并固定整个tool contract fingerprint；同一文件通过正式ToolRouter证明`research.read`是无action receipt的known-URL read，验证stop/abort fence，并固定实际system baseline的版本hash与上述完整关系。`tests/capabilities/environment.test.ts`用导出的Zod schema解析实际环境报告并验证授权失败关系。`tests/daemon/attachments.test.ts`不绕过Router地完成输入到成果闭环。prompt/tool schema或策略变化会使固定fingerprint或baseline hash失败，必须显式审查并走离线迁移。
