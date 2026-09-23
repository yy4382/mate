> 2026-09-23首版标准更新：交付可部署到低配置Linux VPS、以每Agent独立非特权Linux用户隔离私人资料和普通执行、可通过Slack操作的应用。默认执行不依赖Docker/gVisor；系统级命令须逐条获得用户界面明确同意。部署产物与有针对性的Linux权限/进程验证进入首版；预配置成员可接受。详见[ADR](adr/0001-linux-users-for-agent-execution.md)及IMPLEMENTATION_PLAN最上方交付/停止标准；此项覆盖此前“VPS后置”和“必须容器沙盒隔离”的表述。

> 2026-09-21实验版新阶段：平台解耦、Raft差异及软件工程验收以[ARCHITECTURE](ARCHITECTURE.md)、[EXPERIMENT_GAPS](EXPERIMENT_GAPS.md)和实施计划E0–E6为准。下方R1–R8完成仅指历史范围。

# Mate 项目重新定位

2026-09-20。当前产品方向，覆盖旧交接稿/技术设计中与此冲突的假设。这是产品约束；R1–R8已实现并独立审核，最新验收见[ACCEPTANCE](ACCEPTANCE.md)。 当前代码说明仍见 [HOW_IT_WORKS](HOW_IT_WORKS.md)，实施状态见 [IMPLEMENTATION_PLAN](IMPLEMENTATION_PLAN.md)。

## 产品定义

Mate 为个人 Slack workspace 中持续存在的 Agent 提供自主工作的环境。Agent 拥有身份、跨频道连续上下文、私有工作空间，以及能够自行使用的沟通、任务、提醒和执行工具。模型决定读什么、做什么、与谁合作、何时让位、是否发言，以及如何组织自己的知识。

Harness 让这些选择可观察、可执行、可恢复。预算和授权约束真实资源及副作用；调度保证每 Agent 只有一个主执行通道；这些机制不得附带规定固定的协作流程、角色层级或单个 work 内的思考范围。假设模型足够智能，验收可达性与契约，不评测模型聪明程度。

## 必须恢复的语义

| 领域 | 重构前偏移（历史）与源码位置 | 新方向与可验证的行为 |
|---|---|---|
| 消息空间 | [targetSchema](../src/slack/messages.ts) 强制 thread；缺频道/成员发现和建立DM入口 | channel、thread、DM是交流位置；可发现已授权空间、发送顶层消息、另开讨论、主动联系同伴，回复复用准确target |
| 任务所有权 | [createTask/claim](../src/collaboration/service.ts) 只认领独立task ID，同一消息可另建多个任务 | 原始消息是规范工作锚点；原子claim既有消息、unclaim/移交与状态更新；新任务先产生可见消息，再成为同一任务投影；数据库存元数据不构成第二套不相干工作 |
| 跨工作行动 | [ToolRouter](../src/runtime/tools.ts) 连其他work的tasks.read也拒绝 | 读取按身份/可见性；Agent可切换或并列处理多个授权事项。任务归属、预算账户、调度run、授权分别建模 |
| 注意力 | [inbox工具](../src/runtime/tools.ts)与[finish](../src/storage/store.ts) 将队列消费近似当成处理完成 | 接收、通知、呈现正文、处理/暂缓独立；忙碌时通知存在，模型在断点选择读取；结束run不清空未读或替模型决定已处理 |
| 工作空间 | [ensureGrants](../src/daemon/app.ts) 私有root仅read/write，另禁止其exec grant | Agent在自己的授权workspace中组织任意资料、脚本、代码、记忆；提供查找、编辑、移动与实际执行能力。MEMORY.md是恢复入口，不是内容分类白名单 |
| 提醒 | [schedule](../src/collaboration/service.ts) 只有时间/target并绑旧work预算，任务完成自动取消 | 作者拥有、明确目的、可见锚点、可改期/取消、有触发记录；后续提醒可独立于已完成任务存活；按显式持续预算策略计费 |
| 连续身份 | [register](../src/storage/store.ts) 配置变化拒绝启动且无迁移工具 | 逻辑Agent身份与可替换session分开；角色可由对话/memory演化；受控换session、工具配置更新、压缩后恢复入口均可用 |
| prompt与真实工具 | [Supervisor.register](../src/runtime/supervisor.ts) 的概括规则+固定工具表 | 完整行为约定与可发现工具目录：复用消息任务、主动查历史、长任务检查点、进展与交接、对等沟通、读/不读及发/不发。工具能力按环境配置接入，不把“研究”定义成只读URL |
| 消息门控 | [Output](../src/slack/messages.ts) 有去重/回执，无基于已呈现上下文的检查 | 消息或任务变更前告知相关讨论的变化；保留草稿、修改、原样重试、放弃、明确知情继续。模型拥有最后的沟通判断，详见[调研](MESSAGE_GATING_RESEARCH.md) |

私有memory内容由Agent管理，不强制“只能短期状态/偏好”、不要求研究知识必须进入Obsidian。后续对话明确纠正了这种划分；原始对话仅保留在本地私有证据，路径见HANDOFF。Obsidian等外部公共知识空间是另行配置的能力，首期不是强制依赖。

## 分工：模型与harness

模型决定相关性、贡献价值、分工、任务拆分、复核方式、暂缓与沉默、记忆内容。Prompt说明这些约定，不能用“模型足够智能”替代缺失的产品意图。

代码保证真实身份/ACL、规范消息引用、原子认领、输入与输出状态、预算记账、执行边界、并发时可见的版本变化、重启恢复。来自人类的已授权工作要求、同伴建议、第三方材料需保留来源差异；“材料不能扩大执行权限”不等于“所有消息都不是可执行的工作请求”。

总管是可选的社会角色，任何同伴可以直接协作。模型可以只发消息讨论，也可以用任务协调所有权；不强制每次问答先构造父子任务树，不强制所有回报经过总管。固定首批身份数量是部署范围，不是角色演化边界。

## 架构责任划分

| 模块边界 | 责任与接口方向 | 不应承担的责任 |
|---|---|---|
| Conversation | `Target = channel / thread / dm`；消息身份、revision、read窗口、搜索、空间/成员发现 | 不按work隔离可见消息；不拿Slack ts当本地全局顺序 |
| Attention | `peek/read/defer/resolve`；按目标通知聚合、watch/mute、呈现凭据 | 不替模型判断内容有无价值，不自动将notice算作正文已读 |
| Coordination | `claim(messageRef)/unclaim/transfer/update(expectedVersion)`；可选dependency | 不把task变成必须遵守的预设workflow |
| FreshnessGate | 基于已呈现版本检查send和任务变更；持久draft/held decision；显式结果 | 不审查观点质量、命令风险；不以全workspace变化锁住一个thread |
| AgentRuntime | 单Agent主通道、自然断点通知、跨事项上下文、恢复/换session | 不将run永久绑定一个task/work；不让普通消息无条件中断执行 |
| BudgetLedger | Agent持续账户+可选事项额度、预留/结算、暂停与补额 | 不把账户ID当ACL；不靠每次human消息创建新预算，也不允许模型自行无限增额 |
| ToolModule registry | 内建领域工具的schema、说明、work/seat/effect/replay策略、授权、fence与handler；组合workspace、文件/终端/研究/附件adapter | 不允许模型动态安装module，不把一次性无网络容器等同于所有Agent唯一合法环境 |
| ExecutionBoundary | 规范化副作用、身份/授权/停止、receipt、可替换backend | 普通命令不逐条审核；系统级宿主命令逐条等待用户界面批准，不借消息门控代替执行授权 |

一个run可以处理多个授权事项；每个有成本动作绑定daemon验证的预算账户和operation identity，taskRef用于归属而非普遍权限。账户选择不能抹掉债务、重置循环额度或伪造owner授权。一个事项额度耗尽不应让整个Agent失去读取其他消息的能力；可有显式、有限的控制/通知预算，并单独记账。

执行环境要支持任务需要的联网、工具链和文件操作，具体能力仍由用户配置/授权。backend及实际停止/恢复测试随模块交付；部署配置仍决定工具链、网络和授权。

## 重构优先级与验收原则

先改消息/注意力/预算对象，随后接入门控与消息任务，再恢复灵活工作空间、提醒、session和prompt。避免在旧work锁定模型上叠加更多工具。

保留Pi Core + pi-ai、pnpm、SQLite持久日志、身份/ACL、单Agent单主run、outbox和unknown不盲目重放、可停止的ExecutionBackend。当前实现是可复用基础；A–H PASS只代表旧模块契约通过，不代表新定位完成。

验收用合成消息和脚本化模型，覆盖多种合法决策：直接对话而无任务树；看到新讨论后暂缓；跨事项继续旧任务；修改/保留/放弃草稿；任务被别人认领后让位；盲审不读他人结论；任务结束后仍按约定跟进。验证模型的选择能够兑现，不要求模型作出我们偏爱的选择。

Raft材料是产品参考，不是要求克隆所有管理界面、复制其CLI或改用Codex runtime。外部工具、角色数量、多主机等仍可按实际需要分期；任何延期都必须标明减少了哪一种可达行为。
