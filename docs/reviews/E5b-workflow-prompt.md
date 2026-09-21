# E5b 工作输入到成果闭环与行为约定 — PASS

日期：2026-09-21。基线：`d664b5e`。实现后独立只读红队：`/root/review_e5b_workflow_prompt`，未参与实现。范围：当前工作环境报告的artifact actor/target区分、受限URL读取边界、附件到文件再到成果发布的正式Router闭环、system prompt、操作手册和能力证据矩阵。

实现结果：`environment.info`分别报告当前Agent是否配置成果adapter和当前work target是否支持成果输出；实际`artifact.publish/revise`仍对显式target预检。正式Router测试从可见Slack附件开始，经过认证下载、Broker写入、文件读取/处理、成果冻结、源文件后改、`artifact.revise`和held continue，最终验证adapter收到修订后冻结内容。Prompt明确环境快照不是授权、grant相对路径、configured不代表实时健康、known-URL读取不是搜索、attachment metadata不是内容，以及成果preflight/freeze/unknown语义。`docs/CAPABILITY_MATRIX.md`把这些体验连接到公开operation、环境条件、权威状态和实际测试。

红队初审发现并修复两项P1与两项P2：

- Research设计要求缺少私网DNS、跨host redirect、64KB截断和run停止反例。现将DNS/HTTPS收敛为默认`NodeResearchTransport`，生产与测试共用`ResearchBody`字节上限；正式Router另验证await期间run finish和abort后的结果均被fence拒绝。
- Prompt原测试只匹配四个关键词，无法阻止语义漂移。现固定完整tool contract fingerprint与实际baseline configVersion，并逐项核对环境发现、路径、健康、研究替代、附件和成果状态关系；环境DTO同时经过导出的Zod schema解析。
- 能力矩阵中不存在的attention测试路径已替换成真实文件。
- 防漂移说明已收窄到实际检查，并由固定整体fingerprint支持。

红队复审确认生产composition仍使用默认网络transport，没有测试专用旁路；窄transport/collector职责清晰，未引入反向依赖或第二状态源。独立目标验证28/28、`pnpm run typecheck`和`git diff --check`通过，无P0–P2遗留。实现者最终`pnpm run check`：47文件通过、1文件按条件skip，330项通过、7项真实隔离按环境skip。E5b与E5整体PASS，可以进入E6。
