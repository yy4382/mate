# 有界历史读取

Mate 把历史获取分成应用层查询与平台适配两部分。`ConversationHistory` 只处理 canonical message、当前 Agent ACL、分页边界和覆盖说明；`HistorySource` 是可选端口，Slack 适配器负责把 canonical target 与 anchor 翻译成 Slack channel、thread 和 timestamp，并且只使用正在行动的 Agent 自己的 installation。

## 四个模型能力

- `history.page`：按 canonical 顺序读取当前可见的本地历史。内部 channel 的当前成员可读取加入前的房间历史；内部 DM 仍受固定 pair 限制。
- `history.search`：在当前可读范围中做有界正文/作者筛选。一次最多扫描 1000 条；即使本批没有命中，只要仍有范围未扫描就返回 `nextCursor`。
- `history.around`：围绕一个当前可读 message 取最近的前后文。reply anchor 限于所在 thread，顶层 anchor 限于 conversation。
- `history.fetch`：通过当前 Agent 的外部平台 installation 拉取一页，再安静写入本地缓存。它不是全平台搜索，也不会自动追完所有页。

游标是不透明且绑定查询的：actor、operation、target、过滤条件、before/after、limit 和排序任一改变都会拒绝复用。顺序边界同时使用 message order 与 canonical ID，避免相同顺序的重复或遗漏。before/after anchor 本身也必须在调用者当前权限内。

## 安静获取的语义

历史页可以补充消息正文、revision 和该 installation 实际看到的 message visibility。外部 visibility 保存每个 Agent 自己实际收到的 revision 与完整正文快照；即使两个 installation 对同一 provider revision 获得不同的附件展开结果，也不会互相覆盖。一个 installation 拉到新版、旧版、附件或删除状态，不会让另一个 installation 直接读取该正文，也不会使后者的 freshness view 失效。对应 Agent 的新 revision 或正文快照仍写 actor-scoped conversation event，使它自己的旧 view 失效。历史读取不会写 `message_observations`、不会创建 delivery、不会前移 `attention_seen`、不会 resolve 未读，也不会生成 viewToken。

因此 history-first 后真正的实时 event 仍会产生一次 observation 和正常 wakeup；event-first 后重复历史页不会二次唤醒。远端返回的 revision 即使落后于全局缓存，Mate 也会保存并只授予此次 installation 实际返回的快照；共享 current cache 不会回退，也不会被当成本次远端结果返回。`message_revisions` 中已有的历史证据保持不可变，installation 快照承载同 revision 的 provider 表示差异。

## 覆盖和失败

本地结果使用 `local_visible` coverage，只表示此刻本地缓存中、当前 ACL 可见的范围。远端结果区分 `channel_top_level` 与 `thread`，并返回 `available`、`exhausted`、`nextCursor`、`gaps`。`exhausted` 只表示这次 provider scope 没有 continuation；平台保留期、权限、过滤和未能映射的消息仍可能造成缺口，所以 `remoteComplete` 固定为 false。

远程调用前后都会验证 active run、review isolation、ACL 和 membership version。调用等待期间发生撤权、停止或 membership 变化时，返回内容不会写入消息缓存。Slack 没有相应 installation、缺 scope、缺 continuation 或返回无法解析的数据时，工具明确报告不可用或 gap，而不是把局部缓存冒充完整历史。
