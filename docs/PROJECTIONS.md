# 内部会话的 Slack 展示

这是可选的完整会话镜像，不是把所有私聊自动广播到公共频道。内部 DM 本身不依赖 Slack 展示，消息提交和同伴工作不会因展示失败撤销。保留频道的简短 activity 提示是独立能力。

owner 通过 `/team conversations` 查看内部会话 ID，`/team projection-bindings` 查看已有绑定。若要把一个内部会话展示到 Slack：

1. 在 Slack 新建专用频道，先不要邀请 Mate bot。复制频道 ID。
2. 在已有操作频道执行 `/team projection-add INTERNAL_CONVERSATION_ID {"channel":"CNEW","publisher":"research","importUsers":["UOWNER"],"disclose":true}`。`publisher` 必须是该内部会话的当前 Agent 成员。
3. 邀请指定 publisher bot 加入新频道。等待收到的新消息；不会补发旧私聊。

不能把一个已经被 Mate 当作普通外部会话使用的频道直接改成内部私聊镜像。该频道的 locator 已有权威归属，修改会破坏原有消息引用。绑定必须先于 bot 入场；不需要为此修改已有频道数据。

`disclose:true` 明确授权向目标频道披露未来会话内容。owner 应选择合适的 Slack 频道成员；导入白名单不是对外披露权限的替代物。`importUsers` 显式登记可发言的人类内部成员，并允许其输入；它不授予读取所有内部历史的接口权限。未列入的人仍可能在 Slack 看到该频道，但其输入不会进入内部会话。

常用管理命令：

- `/team projections CONVERSATION_ID {"problemsOnly":true}`：held/unknown/failed/drift 状态，返回分页游标。
- `/team projections CONVERSATION_ID {"before":123}`：继续查更早记录；不填 JSON 则查最近一页。
- `/team projection-inputs BINDING_ID`：导入被拒绝或等待线程根的记录；同样支持 `{"before":123}`。
- `/team projection-enable BINDING_ID false`：停止新的展示与导入；已有 unknown 仍允许依据原证据对账。`true` 重新启用未来消息，不补发停用期间消息。
- `/team projection-anchor BINDING_ID ROOT_MESSAGE_ID`：显式创建不含旧正文的线程根提示，供后续回复使用。

`missing_historical_root` 表示该旧根从未向此频道披露，需要上述 owner 锚点授权；`waiting_root_receipt` 表示根正在发送；`root_unknown`/`root_failed` 显示根的发送问题。不会猜成顶层发言，也不会自动重发 unknown。

Slack 回声须匹配已派发记录的 publisher、目标/线程、原 hash 和内容。对账只增加外部定位，不产生第二次 Agent 唤醒。人类回复在根回执尚未到达时单独持久等待，不堵塞普通 ingress；重放时重新检查当前许可。

从 Slack 导入的消息支持单调版本编辑/删除；多个 App 观察同一条消息只导入一次。自己的展示副本在 Slack 被编辑/删除时只标记 drift，不改写内部原文。镜像为首次消息快照：源内容在发送前修改会取消该快照，已发送副本标记过时，不自动覆盖。内部附件发布尚不支持；可向普通 Slack 会话发布成果。

重启先将发送中 projection 标为 unknown，再以原 wire/hash 对账。周期 catch-up 和线程轮转有页数上限，缺口写入 audit；缓存与有限历史拉取不等于完整 Slack 事件历史，尤其不能声称重建服务离线期间所有旧编辑/删除。

开发验证使用真实应用服务和模拟 Slack HTTP/事件协议；真实 workspace scopes、bot echo 与 API 兼容仍需连接后验收。
