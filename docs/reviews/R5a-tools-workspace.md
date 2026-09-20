# R5a 工具注册与workspace — PASS

实现基线235f132。独立只读reviewer：/root/review_r5a（fresh context）；未参与实现。范围：ToolEnvironment注册/发现/参数/执行、私有workspace exec授权、完整结构化文件操作、隔离与恢复。网络/附件/发布门控另属R5b。

检查：pnpm run check 125通过、6真实隔离项默认跳过；显式启用本地SRT/Docker后6/6通过（无镜像下载/外部通信）。reviewer独立5文件44测试通过，真实SRT Unicode回归通过，git diff --check通过。审核与build并发曾引起dist暂时缺失，待构建结束后稳定重跑通过，不将中间失败算成功。

发现与修复：
- P1：自定义adapter直调/tools.call绕过seat。入口先解析别名再统一seat检查；扩展继承currentWork/assertActionWork。新adapter仍由可信host实现领域授权与durable receipts，注册不自动获得Broker语义，接口已明确。
- P1：runner逐chunk String解码UTF-8，真实复现“你”变“���”却成功。输入和输出改流式UTF-8解码；跨字节stdin真实SRT回归、stdout合成helper回归通过。
- P2：in判断误把constructor等原型名称视作内置能力。Object.hasOwn替换，停用事项中的同名adapter拒绝测试通过。
- 补足现有私有grant升级回归：配置Docker且未撤销未过期才添加exec并audit，撤销/过期/无Docker不扩大权限。

最终独立结论PASS，无剩余阻塞。文件read64KiB/write1MB、list/search有界并显式truncated；remove只删除文件/空目录，任意复杂操作可走配置容器内exec。结构化helper依赖OS隔离，模型没有host注册adapter的入口；owner可配置环境。旧session prompt演进由R7完成。
