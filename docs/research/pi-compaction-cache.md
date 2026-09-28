# Pi 自动压缩与摘要请求的缓存前缀

核查日期：2026-09-28。基线为 Mate 当前使用的 Pi 0.86.0；同时检查当日可读取的官方 `main` 摘要实现与扩展类型。`main` 链接会变化，不作为锁定版本。本文区分源码事实、设计推论和本地验证；没有调用真实模型供应商，也没有测得缓存命中率。

## 结论与复用边界

优先适配 Pi 的自动触发、保留近期消息、合法切点、长轮次分割、摘要检查和成功后提交顺序。为了让**摘要请求本身**保留主会话前缀，需要替换 Pi 默认的摘要请求构造；这不是现有默认实现的开关。Mate 继续使用 `pi-agent-core` 与 `pi-ai`，不引入 `pi-coding-agent` 运行时。

Pi 0.86.0 的 `session_before_compact` 提供准备结果、历史 entries、触发原因与取消信号，允许返回自己的 `CompactionResult`；当前 main 仍保留这个入口。这证明其算法与摘要生成可以分开替换，但 Mate 无需为此移植 CLI 扩展系统。[0.86.0 扩展类型][extensions-v]、[main 扩展类型][extensions-main]

## 官方源码确认的行为

| 问题 | 核查结果 |
| --- | --- |
| 默认摘要是否保留原请求？ | 0.86.0 的 `generateSummaryWithUsage` 将选中消息转换成文本，放进单条用户消息；`buildSummarizationContext` 换用专门的摘要 system，未携带原工具定义。已有摘要作为文本合并。main 的对应函数仍采用这一路径。[0.86.0][compact-v]、[main][compact-main] |
| 摘要缓存选项是什么？ | 两版 `completeSummarization` 都明确设 `cacheRetention: "none"`；调用方未给 session ID 时生成新 UUID。0.86.0 `_runDefaultCompaction` 明确不传主 session ID。这是摘要请求的路由 ID，不是给 Agent 新建逻辑会话。[压缩函数][compact-v]、[会话调用方][session-v] |
| 序列化是否无损？ | 0.86.0 官方文档明确工具结果文本截断至 2000 字符；main 的 `serializeConversation` 也采用此限制，提取文字、思考文本和工具调用。专用 system 要求只输出结构化摘要。它不是原生消息重放格式。[0.86.0 文档][compaction-doc-v]、[main utils][utils-main] |
| 压缩如何改变历史？ | 0.86.0 追加 compaction entry，保存摘要、保留起点及当时 system/tool 状态；原始记录仍在。下一请求由该检查点、保留消息和新增消息组成。[session-manager][manager-v] |
| 压缩后会换主 session ID 吗？ | 默认成功路径追加检查点、重建 Agent messages，没有轮换主 session ID。相同 ID 不等于相同请求前缀。[agent-session][session-v] |

0.86.0 在下次 assistant 请求之前及运行结束后检查自动压缩。切点允许 user/assistant，但不能从 toolResult 开始；分割超长轮次时，另总结该轮被裁掉的前缀，保留近期后缀。摘要 error、length 或意外工具调用不作为成功摘要；生成与取消检查完成后才提交检查点。overflow 路径至多压缩后重试一次，失败 assistant 保留在持久历史，重试上下文排除它。[compaction.ts][compact-v]、[agent-session.ts][session-v]

## `none` 不能统一解释为实际零命中

本地安装的 0.86.0 适配器确认：OpenAI Responses 在支持显式缓存模式时，将 `none` 转为 `prompt_cache_options: { mode: "explicit" }`，同时省略缓存 key；其他模型不发送该模式。Anthropic 则不生成 `cache_control`。因此必须看最终请求和供应商语义，不能只看 Pi 选项名。[OpenAI 适配器][openai-v]、[Anthropic 适配器][anthropic-v]

OpenAI 官方说明：支持 explicit mode 的模型，没有显式断点时不使用缓存，也不写缓存；早期模型只有隐式缓存。删掉缓存 key 不能概括为关闭所有供应商缓存。保留原消息与工具定义有助于维护前缀，但具体请求设置仍需按供应商核对。[OpenAI 缓存文档][openai-doc]

**推论：** Pi 默认摘要改变 system、工具集合及消息结构，不能预期复用主会话的大段历史缓存。若保留实际请求的原始前缀，只在尾部追加摘要要求，则有保留缓存复用条件的可能；仍需保持模型、推理设置、工具协议及供应商断点兼容。这不构成命中率保证。[默认摘要实现][compact-v]、[供应商前缀规则][openai-doc]

## 保温与压缩后的第一次请求

Pi 的 cache warmer 重发已经发出的请求，将输出上限设为一个 token。SDK 只让主 session ID 的请求启动保温；独立摘要请求不替换保温目标。它还检查原消息是否仍是当前消息数组的前缀。压缩替换前缀后，该检查失效并停止保温；没有在压缩完成后专门构造新上下文进行预热的路径。下一个普通请求才重新启动保温。[sdk.ts][sdk-v]、[cache-warmer.ts][warmer-v]

**推论：** 压缩后的第一次主请求无法复用被替换的旧历史前缀，需要建立新的缓存；未改变的 system/tool 前缀仍可能命中，所以不应承诺“第一次一定完全 miss”。原会话前缀摘要只改善生成摘要这一步，不消除压缩后新前缀的建立成本。[检查点重建][manager-v]、[前缀匹配规则][openai-doc]

## 专用摘要提示的动机与证据边界

**官方明确说明的动机：** `compaction.ts` 的序列化注释明确说要防止模型继续原对话；专用 system 要求模型只总结，不回答历史中的问题。0.86.0 文档说明工具结果截断是为了控制摘要输入大小；摘要采用新路由 ID，并在供应商支持时关闭缓存写入，是因为一次性摘要请求不太可能再次复用。后者解释的是不为摘要写新缓存的意图，不能单独证明读取主会话缓存没有价值。[序列化与缓存写入注释][compact-v]、[摘要 system][utils-main]、[0.86.0 官方文档][compaction-doc-v]

**官方默认优于候选的质量结论未得到证明：** 维护者 badlogic 在 #128 的 split-turn 设计讨论中提出，两份较小摘要“potentially higher quality”，这是对拆分摘要的预期，不是专用 system 与原生前缀摘要的 A/B 结果。#1748 已有人直接质疑序列化造成缓存损失。[维护者讨论 #128](https://github.com/earendil-works/pi/issues/128)、[质疑 #1748](https://github.com/earendil-works/pi/issues/1748)

#9411 所链接的 fork PR 提供了反方向的实验线索：作者自报在单一 `muse-spark` 模型及 max thinking 下调提示，并进行 42 个留出片段和 40 对 LLM 盲评；另报三个预热片段的前缀匹配约 99.9–100%，以及 126 次以上摘要没有工具调用。这是分支摘要改动，包含提示调整，不能隔离请求结构的因果效果；其 compaction 调用方仍保留 `none`。本次只核对了作者发布的 PR 正文，没有复现实验，不能据此断言 Mate 的候选优于默认。[问题 #9411](https://github.com/earendil-works/pi/issues/9411)、[fork PR #3](https://github.com/cad0p/pi/pull/3)

**推论：** Pi 的结构把历史变成待总结的材料，给摘要任务独立的行为约束，并缩小工具输出；这些是可解释的工程取舍，不足以证明默认摘要一定更好，也不足以证明破坏原前缀是必要条件。保留前缀候选需要另行验证原 system、仍在上下文中的任务与工具是否干扰摘要指令，不能从 payload 可构造直接推导行为等效。

## 保留前缀候选需要验证的最小改动

1. 复用 Pi 的切点和保留近期片段逻辑；用原生历史消息及原 system/tool 定义形成摘要请求，只尾部追加摘要要求。保留原缓存路由与设置，不调用会强制 `none` 的默认摘要包装函数。
2. 保留原工具定义及工具选择设置；不为摘要单独切换工具选择，避免引入未经验证的缓存变化。摘要调用不运行工具执行循环，任何工具调用或不完整输出都拒绝作为摘要。对供应商最终 payload 检查前缀，而不只比较 Pi 消息对象。
3. 先得到完整摘要，再由控制面确认检查点并切换活动上下文；失败保留原记录和可恢复状态。提前压缩需要给摘要指令与输出留空间；已经 overflow 的上下文不能假定追加指令就能成功。
4. 控制面确认、会话所有权和未知副作用恢复属于 Mate 的适配层；不照搬 Pi 的 CLI、分支树、费用驱动保温或旧格式迁移。以上是实现建议，基于 [Pi 算法与提交顺序][session-v]、[合法切点][compact-v]、[供应商前缀规则][openai-doc]。

## 验证状态

可复现脚本：[pi-compaction-prefix-probe.mjs](./pi-compaction-prefix-probe.mjs)。在仓库根目录执行：

```sh
pnpm exec node docs/research/pi-compaction-prefix-probe.mjs
```

实验使用本地 Pi 0.86.0 的 OpenAI Responses（`gpt-5.4`）和 Anthropic Messages（`claude-sonnet-4-6`）适配器，输入是含思考签名、工具调用 ID 和结果的合成历史。`onPayload` 捕获请求后立即终止；额外的 fetch 防护计数为 **0**，没有请求供应商。

两种适配器均通过：完整历史尾部追加摘要指令时，原请求消息项保持为前缀；从合法边界截取较早历史再追加指令时，保留部分仍匹配原请求前缀。实验保留原 system、tools 和推理设置，确认合成签名与调用 ID 未被丢弃。比较仅忽略 `cache_control` 的位置元数据；其位置变化对实际供应商缓存的影响仍需另行验证。[实验代码](./pi-compaction-prefix-probe.mjs)

脚本中的 Pi 风格摘要请求仅为依据上述源码做的本地形状复现，没有执行上游压缩函数。实验说明两种适配器可以序列化这类请求，**没有验证供应商接受合成签名、真实缓存命中率或摘要质量**，也未验证所有模型及自定义供应商。结论限于保留原始前缀的摘要方案具备本地协议可行性。

进一步验证应分层：先用真实供应商接受的历史确认传输与缓存读数；再固定同一模型、历史和推理设置，对比 Pi 默认摘要与前缀候选，检查是否只输出摘要、是否出现工具调用、事实遗漏与错误、长度和 overflow 行为。缓存检查与摘要质量检查是不同证据，后者不能由一次成功请求代替。本次没有执行这些供应商实验，也不将模型质量评估新增为发布阻塞条件。

**待用户选择的研究建议：** 仅凭本地序列化实验就把前缀摘要指定为必选实现，承诺过早。建议默认适配 Pi 现成专用摘要方法，把保留前缀留作待对照验证的候选；这项建议尚未成为项目决策，本文不修改既定 ADR 或规格。

[compact-v]: https://github.com/earendil-works/pi/blob/v0.86.0/packages/coding-agent/src/core/compaction/compaction.ts
[compact-main]: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/compaction.ts
[compaction-doc-v]: https://github.com/earendil-works/pi/blob/v0.86.0/packages/coding-agent/docs/compaction.md
[utils-main]: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/utils.ts
[session-v]: https://github.com/earendil-works/pi/blob/v0.86.0/packages/coding-agent/src/core/agent-session.ts
[manager-v]: https://github.com/earendil-works/pi/blob/v0.86.0/packages/coding-agent/src/core/session-manager.ts
[extensions-v]: https://github.com/earendil-works/pi/blob/v0.86.0/packages/coding-agent/src/core/extensions/types.ts
[extensions-main]: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts
[sdk-v]: https://github.com/earendil-works/pi/blob/v0.86.0/packages/coding-agent/src/core/sdk.ts
[warmer-v]: https://github.com/earendil-works/pi/blob/v0.86.0/packages/coding-agent/src/core/cache-warmer.ts
[openai-v]: https://github.com/earendil-works/pi/blob/v0.86.0/packages/ai/src/api/openai-responses.ts
[anthropic-v]: https://github.com/earendil-works/pi/blob/v0.86.0/packages/ai/src/api/anthropic-messages.ts
[openai-doc]: https://developers.openai.com/api/docs/guides/prompt-caching
