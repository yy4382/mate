# R0 — 项目重新定位与消息门控研究（PASS）

日期2026-09-20，基线`7f1d1ef`。范围仅文档：PROJECT_DIRECTION、MESSAGE_GATING_RESEARCH、IMPLEMENTATION_PLAN、AGENTS及README/HANDOFF/HOW_IT_WORKS/ACCEPTANCE/历史设计入口。运行时未变；R1–R8尚未开始，不将设计说明标成已实现。

## 验证

- 对照本地Raft developer prompt、后续对话证据和实际src：任务消息锚点、跨work可达性、inbox呈现与处理、workspace、提醒、session及prompt偏移。
- 核对原始session工具回执226/320/517/531，确认真实held draft/任务变更未应用；只记录行为与行号，不复制私人消息到报告或测试。
- 阅读Raft官方held draft文章、OpenClaw steering、Claude Agent Teams、Slack postMessage/Events API；明确外部事实、源码事实与Mate建议的区别。
- 检查已安装Pi Core 0.86.0实际声明和实现，有steer/followUp契约，不据此声称Mate已接通。
- 新文档及入口本地Markdown链接检查通过；git diff --check通过。纯文档交付，不重复执行66项runtime测试，也未连接Slack/provider。

## 独立红队

reviewer `/root/review_r0`，fresh context，只读，独立阅读实际diff/源码/Pi声明/Slack参数与原意证据。

- 阻塞：最初要求没有viewToken先read，盲审首发既无token又不能read，无法获得hold receipt。已修为无token首次submit产生baseline_unknown held和opaque receipt；明确继续与seen分开；补新seat首发/重启验收。实现者和reviewer在同一轮分别发现此路径，reviewer已复核修复。
- 非阻塞：压缩后的重取措辞可能再次强制read。已明确只有重新建立有效viewToken才重取；仍可在未知基线hold后选择知情继续，不推进seen。
- 补充：盲审不能消除已经进入context/memory的结论，建立seat需检查来源，必要时独立reviewer身份和干净上下文。

reviewer已复核最后修正，最终gate：PASS（修复后），无遗留阻塞。R0通过不代表门控运行时已实现。
