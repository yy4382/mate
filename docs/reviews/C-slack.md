# C Slack 消息服务审核

- 作者 /root；独立 reviewer /root/review_c，fresh context，只读。
- 范围 src/slack、storage v2 migration/notBefore、tests/slack、共享合成配置 fixture、SLACK_CONTRACTS。
- 初审发现：跨20秒窗口重放普通消息重复notice；P1内部Slack错误可能部分成功却被标failed；P2慢429提前重试；P2Slack格式化链接/emoji导致正确对账被拒。
- 修复：Agent/message/revision observation唯一键；明确错误白名单，其余unknown；从收到429时刻计时；可信transport写metadata id+request_hash，对账校验sender/target/id/hash并保留Slack规范正文。
- 复审：review_c 独立 check 27 tests/typecheck PASS，并以临时脚本复现验证fatal_error、错误hash拒绝、emoji对账、慢429与transport哈希一致。
- 无剩余已发现阻塞，C gate PASS。真实Slack连接、成员同步及网络权限仍在G验收。
