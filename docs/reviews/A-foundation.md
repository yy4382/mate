# A 基础与 SDK 契约审核

- 作者：主任务 /root；独立 reviewer：/root/review_a（fresh context，只读）。
- 范围：package/lock/tsconfig、src/config.ts、tests/config、tests/contracts、tests/helpers/pi、SDK_CONTRACTS。
- 检查：Node 24.21.0，typecheck、build、11 个测试通过；私有 reference 被 gitignore；依赖树无 coding-agent。
- 初审：2 个 P2 验收阻塞。持续存储故障可能让 prompt reject 而 errorMessage 为空；owner 与 bot identity 可重叠。
- 修复：持续失败/idle/工具未执行契约；明确捕获 rejection 与独立故障标志；配置身份不相交校验及回归。
- 复审：review_a 独立运行 check，11/11 通过，两项关闭，无剩余阻塞。A gate PASS。
- 限制：模型为合成 stream，Jev 为 SDK 自定义 fetch，未发生真实模型/Slack/Jev 调用。后续风险仍按各模块验收。
