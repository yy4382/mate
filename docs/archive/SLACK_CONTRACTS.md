# Slack 消息层边界

C 实现官方 SDK 适配，所有检查目前使用本地合成 Slack 事件与 mock 网络；未创建 app、未发送真实 Slack 消息。

- DurableReceiver 从已绑定 app/team 的 Socket Mode 连接接收。SQLite commit 成功才 ack。业务由持久 ingress replay 驱动；Bolt processEvent 在 ack 后调用，不承担持久接收保证。
- message 原始版本使用 message ts；编辑使用 edited.ts/event_ts，删除使用 event_ts。普通 echo 的 event_ts 不是新消息 revision，避免 receipt 与 echo 二次唤醒。
- 当前 channel_access 与每条 message_visibility 双重限制读取；退出后缓存不可绕过权限。membership 只能由可信成员事件/Slack API 对账写入，配置中的 attention 不是访问许可。
- direct/watched 消息建立独立 durable delivery；participate 普通消息按频道与 20 秒窗口合并 notice，并用 notBefore 延迟领取。notice 不等于正文已读，工具可读取频道 recent/history。
- 输出 target 必须显式 channel+thread。Web API 写请求 retries=0，outbox 管理 pending/sending/sent/unknown/failed。429 按 Retry-After，传输错误保留 unknown。
- SDK 类型未声明 client_msg_id；使用受支持的 message metadata（mate_outbox/id/request_hash）标记逻辑输出，不能把它当 Slack 的幂等保证。对账要求来自新鲜 Slack history 的 sender、target、metadata id/hash 全匹配。Slack 会规范化链接和 emoji，正文不做原样比较；内部消息采用历史的规范正文。metadata 仅由可信 transport 生成，未暴露给模型。没有证据不重发。
- 成功 receipt 与内部消息/同伴 delivery 在同一事务提交；后续 echo 归一。事务失败时保留 sending，由重启恢复转 unknown。

G 仍需连接 app、初始身份/成员核对、补齐历史与关注线程、调度 ingress/outbox、控制入口。真实 Slack 安装、权限、bot echo、消息 metadata 可读性和历史缺口另行验收。
