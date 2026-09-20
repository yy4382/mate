# R4 规范消息任务

基线78b26ad，独立红队`/root/review_r4`最终PASS。pnpm check 115普通测试通过、4真实隔离默认skipped；红队独立复现与针对测试12/12通过。无真实Slack/provider调用。

实现唯一message_key锚点、expectedVersion/owner CAS、claim/unclaim/transfer/update/wait门控及held intents；先消息visible再激活新task；固定状态投影；跨事项依赖；legacy无来源任务不猜测合并。

红队修复：P1已sent未activate时peer claim重复task，规范查询先收敛可见草稿；P1暂停waiter回滚独立dependency完成，改持久wake+bind等resume；P1顶层task没有thread，事件从canonical源消息定位；P2wait绕行改为门控CAS；P2终态dependency重复投影，no-op不投影，waiting转换doing清依赖并递增版本。无遗留阻塞。
