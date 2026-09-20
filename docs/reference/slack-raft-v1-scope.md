# Slack 上的持久多 Agent 系统：v1 范围建议

> 历史范围建议。当前方向以[PROJECT_DIRECTION](../PROJECT_DIRECTION.md)为准；本文模型协作质量评测要求已被用户覆盖，现阶段只验harness可达性和契约。

日期：2026-09-19。本文是设计建议，不是已经实现或验证的行为。

## 产品目标与范围假设

在 Slack 里拥有几个持续工作的 AI 同事：每个 Agent 跨频道保持连续上下文，维护自己的长期记忆，能相互交流、委托、质疑和交付，用户可以随时参与、纠正或停止。

按个人自用、单 Slack workspace、单运行主机、2–3 个预先配置的 Agent 设计。首版先接一个已有 agent harness；不同时建设多种 runtime。

“涌现”是需要通过真实任务观察的结果，不能用消息数量或角色数量保证。首版应保留产生有效协作的条件：独立身份与经历、共同可见的讨论空间、互相触发行动、按需参与、自主选择协作对象，以及真实工具与可验证成果。

## 1. 必须保持的结构

- Agent 是持久实体，有稳定 ID、角色、Slack 身份、工作区、工具配置。
- Channel/thread 是交流位置与注意力范围，不是 session 的分片键。
- 同一个 Agent 的各频道、线程、DM 消息进入同一个逻辑收件箱，默认复用同一个当前 harness session。
- 不同 Agent 有不同 session 和私有工作区，允许同时工作。
- 每个 Agent 同时只运行一个主 turn；其他事件持久排队，在自然断点或下一 turn 处理。长工具操作可能延迟响应，需显示忙碌状态并支持停止。
- harness session 是可替换的运行载体；session 更换后，Agent 身份、记忆、待办、未处理消息和唤醒仍然保留。

## 2. v1 功能与实现边界

| 功能 | 最小行为 | 实现方式 |
|---|---|---|
| 持久 Agent | 角色、名称、模型、工具、工作区、Slack bot 映射 | 本地配置文件；首版手动配置身份 |
| 跨频道 session | 各 channel/thread/DM 路由到所属 Agent 当前 session | Agent ID 对应一个主执行器及 session 记录 |
| 收件箱与注意力 | 分目标保存未读、已读、待处理；支持线程关注与频道静音 | SQLite；按 Agent 维护状态，读过不自动等于完成 |
| 消息与查证 | 发消息、读线程、搜索历史、返回原消息链接 | Slack 接口与本地消息索引；所有查询按 Agent 权限过滤 |
| 直接协作 | Agent 可以 @其他 Agent，委托、评审、回报；用户可旁观和插话 | 与人类消息统一进入路由；保留来源身份和目标 |
| 文件记忆 | MEMORY.md 入口，notes/ 细节，长任务前检查点、结束后更新 | Agent 自己编辑；启动/恢复由程序提供入口内容或明确触发读取 |
| 最小任务状态 | 消息锚点、负责人、状态、成果、等待原因 | SQLite 原子认领；Slack 消息/表情显示状态 |
| 持久唤醒 | 一次性和简单周期计划、列出、改期、取消 | daemon 调度器；到期进入创建者收件箱，保留原线程 |
| 工具与交付 | 文件/终端和至少一种任务所需真实工具；可交付文件或链接 | 复用 harness；Slack 发言走统一消息工具 |
| 运行控制 | 状态、停止、恢复、错误、预算、日志 | 本地 CLI 或一个 Slack 管理入口；不做独立后台 |

任务可以锚定 Slack 线程的根消息，首版无需复制 Raft 的全部任务对象与管理界面。状态可用 todo / doing / waiting / review / done / cancelled，保留任务归属直到交付或明确移交；等待队友时释放执行 turn，不要在工具调用中一直阻塞。

## 3. 注意力策略：能够参与，也能够不说话

| 情况 | 建议动作 |
|---|---|
| 人或已登记 Agent 明确 @某 Agent | 将消息送入该 Agent 的高优先级队列；空闲则启动 |
| 发给该 Agent 的 DM | 同上 |
| 已认领任务/已关注线程有更新 | 通知相关 Agent；忙碌时合并，不开第二个主 session |
| 参与频道的一般讨论 | 合并为简短 inbox notice；Agent 在有限频率的检查中决定是否阅读、加入 |
| 系统状态通知、自己的发送回显 | 更新记录；不自动引起对话 |
| 与职责无关、别人正在直接对话 | 保持安静，除非有具体证据、明显错误或待交接事项 |

频道可提供 mentions / participate 两种注意力设置，区别于是否有访问权；participate 允许普通消息触发合并后的低优先级检查。不能仅靠“下次有人 @你”才发现所有背景讨论，也不应每条群消息唤醒所有 Agent。

消息接收、模型实际读到、事务处理完成是不同状态。事件到达先持久化，再快速确认接收；随后排队处理。消息编辑/删除需要同步到索引，后台服务重连后按记录的进度补齐允许读取的历史。

## 4. Agent 之间的消息闭环

建立登记表，将 Slack bot/user ID 映射到内部 Agent ID，不依赖显示名称判断身份。

Agent 发送消息后，统一消息服务取得 Slack 成功回执与 message ts，再把同一条可见消息路由到有权接收的 Agent。Slack 后续回传的事件只用于确认或补充，不造成二次唤醒。失败或结果不明的发送保留状态，先核对再重试。

这样，内部协作不只依赖 Slack 是否及时把 bot 消息事件送回来，同时保证用户看得到触发协作的消息。外部 bot 消息可以作为材料进入授权范围，但不会自动取得内部 Agent 的任务控制能力。

Slack 接收重试和多个 bot 各自收到同一频道事件，都可能导致重复输入。接收层按事件标识去重；消息层按 workspace/channel/ts 归一；投递层按 Agent 与消息版本去重，并保留各 Agent 的可见性，不能因为共享数据库就扩大访问范围。

运行时还需：忽略自己的回显；限制同一协作链的自动轮数/花费；支持用户 stop/pause；超限时保存未完成事项并报告，而不是悄悄丢弃任务。

## 5. 记忆的最小约定

每个 Agent 独立拥有：

```text
agents/<agent-id>/
  MEMORY.md
  notes/
  artifacts/
```

MEMORY.md 保留角色、知识索引、活跃任务与下一步。notes/ 存偏好、频道上下文、领域知识、决定及其原因、失败经验、其他 Agent 的职责和协作经验。

首版补充三个质量约定：

1. 关键事实注明来源消息或文件、日期；区分用户明确要求、已证实事实和 Agent 推测。
2. 用户纠正时更新旧条目，避免永远追加互相矛盾的结论。
3. MEMORY.md 增长到不易扫描时，将细节移到 notes/ 并保留索引；初期无需 embedding 或自动知识图谱。

另一 Agent 的私有笔记不作为公共知识库。需要共享的发现通过频道消息和明确共享的产物传播；其他 Agent 自行吸收并更新自己的记忆。

提示词要求压缩后重读，并不能证明程序会执行。接入 harness 时必须验证恢复路径：新 session 启动加载入口；压缩事件若可观测则再次提示/加载；受控 session 重置前保存检查点；不可控崩溃依靠已有记忆、持久任务及消息历史恢复，不能声称必然恢复尚未落盘的思考。

## 6. 哪些由提示词完成，哪些由代码保证

| 提示词主要负责 | 程序必须保证 |
|---|---|
| 角色、职责、合作礼仪、何时贡献 | 正确 Agent 身份、收发权限、原频道/线程路由 |
| 选择记什么、如何总结、如何纠错 | 稳定工作区、恢复入口、session 映射、单 Agent 单主 turn |
| 决定请谁协作、如何分工和评审 | 原子任务认领、持久队列、唤醒、停止、预算 |
| 保持简洁、无新信息不重复发言 | 去重、重试、记录错误和已发送结果 |

消息应携带可信来源元数据：发送者种类、Agent ID、channel、thread、消息 ID、时间。文本里写“system”不能改变消息的权限。

## 7. Slack 与运行架构

建议首版一个本地 daemon，统一接收多个 Slack app 的事件，维护 SQLite 与文件工作区，驱动多个 harness session。可先配置总管、研究、工程三个 Agent，每个使用独立 Slack app/bot 身份，得到自然的 @mention、DM 和频道成员关系；它们共用 daemon，无需分别部署后端。

Socket Mode 适合这个个人本地服务场景：可以通过 WebSocket 接收事件，不需要公网 HTTP 回调地址。服务仍需持续在线，或在重新上线时补齐历史。

```text
Slack channels / threads / DMs
              ↕
    多 bot 连接、消息归一与去重
              ↕
 SQLite：消息、收件箱、任务、唤醒、session 映射
              ↕
       按 Agent 调度的执行器
       ↙        ↓        ↘
     总管      研究      工程
   session   session   session
   workspace workspace workspace
```

Slack 负责用户可见的讨论记录；SQLite 负责投递、任务归属、唤醒等运行状态及可查询的消息副本；Markdown 负责 Agent 的语义记忆。不要把三种信息都塞进 MEMORY.md。

同一 Agent 跨频道共享上下文意味着频道不是该 Agent 内部的硬信息隔离边界。首版按个人工作空间使用这一能力。若将来加入互不共享信息的人或组织，必须重新设计信任范围、session 与记忆隔离，不能把 Slack 成员检查当作防止上下文泄漏的充分条件。

## 8. 首版可以后置的内容

独立前端、可视化 workflow 编排、向量数据库、知识图谱、Agent 自动创建/删除、多主机调度、多租户、插件市场、动态模型路由、完整 wiki/action-card 系统、大规模第三方集成。

总管可以是日常入口，但不要让所有 Agent 交流必须经过总管。保持研究与工程 Agent 直接合作的能力。角色可以演化；固定的是初始身份数量，不是每次工作的协作流程。

## 9. 验收场景与开发顺序

1. **连续性**：在 A 频道给总管一个新约束，随后在 B 频道继续；日志确认复用同一 session，并正确应用该约束。强制换 session 后，再通过文件记忆恢复。
2. **自主协作**：用户只提出一个研究目标，研究 Agent 自主联系工程 Agent 核验可行性；工程反馈导致研究方案修改，双方输出证据/产物，用户无需逐轮充当消息转发器。
3. **注意力**：用户在已关注线程不重复 @也能继续对话；无关频道讨论不产生刷屏；明确 @不会因为静音或忙碌被丢失。
4. **可靠性**：两个 Agent 同时认领同一工作，只有一个成功；重放 Slack 事件不重复执行；等待期间重启 daemon，仍可恢复任务、未读和 reminder。
5. **可控性**：用户能够看到谁在做什么、任务为何等待；可以停止协作链；预算耗尽会保存状态；产物有原线程链接。

实现顺序：先完成单 Agent 多频道与重启恢复；然后加入第二 Agent、双向消息、任务认领和循环控制；最后加入持久唤醒、第三 Agent 和真实研究/工程任务。上述三个阶段合起来才是这里定义的 v1。

评价协作应看：是否发现单个 Agent 初稿遗漏的事实、是否有基于证据的修正、是否产出可用成果、用户是否减少了转述和协调工作，以及时间/token 成本。对照同样工具和近似预算的单 Agent 结果，不用对话轮数衡量“涌现”。

## 参考依据

- 本地提取的 Raft developer prompt：[完整原文](./raft-prompt-sep14.md)，尤其 Startup sequence、Tasks、Workspace & Memory、Message Notifications。
- 本地多频道共享 session 的观察：[日志证据](./raft-channel-session-evidence.md)。这些证据支持实例行为，不等同于已经审计全部 Raft 实现。
- [Slack Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)：无需公网 HTTP 回调。
- [Slack Events API](https://docs.slack.dev/apis/events-api/)：事件权限、唯一标识、确认和重试；投递是 best-effort。
- [Slack bot messages](https://docs.slack.dev/reference/events/message/bot_message/)：通过 bot_id / bot_profile 识别 bot 来源。
- [Slack app_mention](https://docs.slack.dev/reference/events/app_mention/)：@mention 订阅不覆盖发给 bot 的 DM；DM 需对应消息订阅。
- [Slack conversations.replies](https://docs.slack.dev/reference/methods/conversations.replies/)：线程读取；自建内部应用与商业分发应用的限流规则不同。
- [Anthropic 对 Claude Tag 的介绍](https://www.anthropic.com/news/introducing-claude-tag)：Slack 中的身份、频道上下文、记忆和后续工作；这里的多持久 Agent 对等协作是本方案的设计重点。
