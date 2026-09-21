# E2c2a projection 核心

状态：独立红队PASS；全套238项通过，7环境测试跳过。

实现前设计：review_e2b2c_canonical复审ARCHITECTURE末尾c2条款PASS；此前binding双权威、披露授权、旧根、echo确认、导入反射/编辑/依赖等约束已补齐。本gate只实现核心projection授权、状态、原子queue与确认；c2b后接Slack和导入。

独立代码review：`/root/review_e2c2a_projection`，新上下文只读，未参与实现。基线435befe。

实现：projection_bindings复合FK引用唯一conversation_binding，publisher/locator不可变；message+binding唯一outbox，冻结wire/hash；投影确认仅补外部message binding，不产生第二次内部message/delivery。内部事务排队与工作一起提交；unknown不重投；停用/撤权/异步权限变化/旧根显式空anchor；待发源内容变化终止，已发源变化标drift。bounded轮转扫描避免依赖阻挡其他binding。

新增9项协议测试使用合成transport：echo早于HTTP、重复/假hash/错误publisher/text/root、unknown恢复、原子内部持久性、旧根空anchor、root依赖与独立binding、异步权限变化、源变更和持久不可变约束。现有生产daemon没有安装projection transport或启用schema19；核心不宣称真实Slack接通。导入/反射/revision及完整进程重开验收在c2b。

最终审核：review_e2c2a_projection独立全量238/7skip，并在/tmp补测projection插入故障令canonical/input receipt一起回滚、真实DB重开unknown保留并可迟到确认、105条dependency-held后的独立根两次flush可达。无正确性/恢复/架构阻塞。

非阻塞P2须在c2b修：list固定最新100条可能遮蔽更早unknown，管理接线前加分页及失败过滤/明确coverage，不能宣称全部失败可见。c2a无管理入口故不阻塞；后续gate必须验收。
