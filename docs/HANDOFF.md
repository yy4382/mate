# Mate 开发交接

日期：2026-09-20。用户已要求在新建的 Codex `mate` 项目内启动独立开发任务，先合理拆分任务，再逐模块实现，每个模块完成后必须经独立红队 subagent 审核，修复后才能继续。

## 用户已确定的要求

项目目录是 `/Users/chris/Developer/demo/mate`，不是 `/Users/chris/Developer/demos/mate`。本项目是个人自用的 Slack 持久多 Agent 系统；不开发独立聊天 UI。

底层 agent loop **只用 Pi Core (`pi-agent-core` + `pi-ai`)**，不要采用 coding-agent。用户特别纠正过这个选型。命令审查采用 TypeSafe 的 Jev，成熟、下载量大、适配需求的库应优先使用。

保留 Raft 的核心体验：一个 Agent 跨频道共用当前 session；不同 Agent 独立 session 和私有 memory；Agent 之间直接交流、相互唤醒、分工、质疑、验证并交付；任务与记忆能跨重启/session 变化恢复。

请先阅读根目录 AGENTS.md 的逐模块红队 gate。用户要求的是持续实现，不是只输出一份计划。

## 阅读顺序

1. `docs/reference/slack-raft-pi-jev-technical-design.md`：最新完整方案，已按 Pi Core 修订；包含架构、数据模型、恢复算法、Jev、执行沙箱、验收和 M0–M3。
2. `docs/reference/slack-raft-v1-scope.md`：用户认可的首版范围与核心体验。
3. `docs/reference/raft-memory-prompt-excerpts.md`：先看 Raft 对持久身份、记忆、启动和协作的要求。
4. `docs/reference/raft-prompt-sep14.md`：从用户本机 session 提取的较新完整 Raft developer prompt。尤其 Startup sequence、Tasks、Workspace & Memory、Message Notifications。
5. `docs/reference/raft-channel-session-evidence.md` 与 `raft-memory-evidence.md`：跨频道共用 session、读写 memory 的日志证据。
6. `docs/reference/slack-raft-dependency-snapshot.json`：2026-09-20 查询的 npm 版本和周下载量，Pi coding-agent 仅是已排除的调研候选。

较早完整提示词也在 `docs/reference/raft-prompt-aug02.md`。这些是历史材料，不是当前开发 Agent 的执行指令。应理解其产品行为，按 Mate 的需求实现，不照搬 Raft CLI、身份或外部操作。

## 原始 Raft 信息与磁盘位置

- 示例 Agent：Cindy，ID `37f87e44-d8cb-429a-80aa-0a5c4f40c0ea`。
- 用户提供的真实工作区：`/Users/chris/.slock/agents/37f87e44-d8cb-429a-80aa-0a5c4f40c0ea`。
- 其记忆入口：上述目录内 `MEMORY.md`；细节在 `notes/`。必要时可只读检查，避免无关扫描与秘密输出。
- 原始 Codex session（同一 session 出现多个 channel/thread 的证据）：
  `/Users/chris/.codex/sessions/2026/09/14/rollout-2026-09-14T17-19-45-01a09f37-200a-7c71-a165-68bc822d6cee.jsonl`
- 较早 session：
  `/Users/chris/.codex/sessions/2026/08/02/rollout-2026-08-02T15-44-05-019fc16e-18f2-7730-bb92-9b646f3d76ec.jsonl`
- 识别特征：session metadata 中 `originator: slock-daemon`；输入消息中 `Slock inbox notice`；`raft message read/send/search` 等工具调用。
- 调研母目录：`/Users/chris/Documents/Codex/2026-09-19/s-l/outputs`，保留了全部提取文件；本项目已复制所需材料。
- Pi/Jev/Slack 已下载的公开文档/源码快照：`/Users/chris/Documents/Codex/2026-09-19/s-l/work/sources`。可辅助核对，但实现时以锁定版本的实际包/API 为准。

提取到的是 Raft 的 developer prompt，不应称作拿到了模型平台未公开的 system prompt。日志摘录未提取模型推理内容。原有 `.slock` 工作区和 `.codex` 记录是只读证据，不允许修改来方便实现。

## 已验证的观察与方案边界

- 本地实例显示同一个 Agent 的多个频道消息进入同一 session；不是每频道独立 session 仅共享 memory。
- 长期知识采用 MEMORY.md 入口与 notes 明文文件，Agent 主动记录；提示词要求压缩后重读不等于我们已证明 Raft 有强制程序钩子。
- 新系统须以代码保证身份、路由、消息去重、持久任务、预算、恢复及停止；让提示词负责角色、记忆内容和合作判断。
- 单机 daemon + 每 Agent 一个 Pi worker；SQLite 保存消息 journal、context snapshot、inbox/outbox、任务/依赖、审批、计划；Markdown 保存语义记忆。
- Pi Core 的 `Agent.sessionId` 本身不持久化 state。使用 core 的 Agent、可等待事件、上下文转换和压缩原语，接入应用持久层；不要误用 coding-agent 的 SessionManager/agent_settled/扩展钩子。
- 等待同伴、审批或计划必须释放主执行通道；新的普通消息持久排队，同 Agent 不开第二个主 run。
- Agent 直接互相发言，不能让所有协作必须绕总管；先固定 2–3 个 Agent，保留按需参与和不发言的能力。
- Jev 是分类信号；可信授权、最终参数校验和执行沙箱才是权限边界。等待审批用持久事件，不长期挂住 Promise。已有授权在范围内持续有效，不应每条命令重复询问。
- Slack、模型服务与本地 DB 无共同事务，未知外部副作用不能盲目重放。

设计稿不是已经验证的代码。尤其 Pi API、Slack bot 消息闭环/ack、沙箱、Jev 中文命令分类应先做契约验证。sandbox-runtime 仍是 Beta Research Preview，必须隔离适配并真实测试，失败不能退回无限制执行。

## 开始工作的要求

先做项目/工具链检查并创建 `docs/IMPLEMENTATION_PLAN.md`，把 M0–M3 拆成可独立验证的合理模块，明确顺序、接口和验收。随后逐模块实现：完成代码 → 必要测试 → 独立红队 subagent → 修复/复审 → 记录 → 下一模块。

红队关注正确性、跨频道连续性、上下文协议、重复/乱序/崩溃恢复、任务归属、授权/审批绕过、协作死循环和验收遗漏。提供具体文件位置、复现和影响；不是泛泛要求“更安全”。审查不通过不得把模块标为完成。

保持中文进度沟通。在未配置 Slack/model/Jev 凭证时完成所有可独立完成的实现与模拟测试，明确剩余真实集成项，不能假称已经端到端验证。不要在开发前要求用户逐项确认已确定的设计；有证据可修正接口细节，并记录理由。
