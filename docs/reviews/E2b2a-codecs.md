# E2b2a — 旧载荷只读解释边界

状态：PASS。独立 reviewer：`/root/review_e2b2a_codecs`（fresh context，未参与实现）。架构拆分讨论：`/root/review_e0_architecture`。

范围：domain/messages、slack/legacy-codec、storage/conversations、tests/conversations/records。只读codec/records，不接生产或改变SQL/writer；E2b2b的writer+索引+查询仍须同gate接入。

实现：规范消息DTO保留实际author与独立origin；外部principal带provider/workspace命名空间，unknown不带身份ID；统一精确整数比较。读取校验消息主键、已知根、目标映射与索引。targetedEffect只处理显式会话target，将canonical target与原request/hash/receipt分开，不充当权限检查或通用action resolver。

架构讨论修复：不将系统生成消息作者改成system；核对查询key；收窄effect名称与范围；外部principal命名；统一排序契约。读取缺失/冲突失败，不写入修复。

红队发现P2验收阻塞：user/bot分别映射两Agent时，OR查找使author随配置顺序变化。已分别匹配并拒绝矛盾证据；覆盖两种排序、单侧未知冲突及合法单bot/未知来源。补齐mutableTarget读取、缺对象/缺索引/漂移与读取不写测试。

检查：最终完整pnpm test（隔离Node24）197通过、7跳过；独立records/reference复验14/14通过。git diff --check通过。一个较早重复全套测试进程未返回结束（原因未确认），已停止；最终197项为后续完整运行成功结果，不将被停止运行当成功。

最终：reviewer明确软件工程（依赖、职责、API、迁移）及正确性无剩余阻塞。没有真实Slack/provider调用，不表示非Slack全链路或整个实验版本完成。
