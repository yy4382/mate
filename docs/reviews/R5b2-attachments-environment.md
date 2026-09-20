# R5b2 附件与可配置环境 — PASS

基线9e5a542。fresh-context只读reviewer /root/review_r5b2，未参与实现（提供两个临时复现，已作为永久回归保留）。范围：可见消息附件metadata/保存、二进制workspace/冻结发布、环境发现与网络配置、review seat强制断网、publication echo去重。

验证：pnpm run check 144通过、7真实隔离默认跳过；reviewer独立全套144通过/7skip。实现者真实SRT/Docker 7/7通过，新增二进制往返与bridge/none路由表检查；不访问外网、不拉镜像、不发Slack。Slack下载/上传为合成SDK+fetch协议测试，不称为真实集成。

发现与修复：
- P2：旧attention page无附件，之后同revision cache补齐files，旧page ACK会错误推进seen。呈现时额外对比当前files结构，相异不推进；view的event revision同时失效。独立复现由失败转通过。
- P2：echo先到、publication ACK后到，前者会重复计未读。ACK同步匹配作者/target/caption/单fileId的echo；正反到达顺序均有回归。

reviewer未发现新增凭证/ACL/路径/未知写重放/席位联网绕过，最终PASS。文件最大1MB，binary读取每块32KiB且带总大小/SHA256；发布快照跨块一致检查，draft只显示元数据，原字节持久保留。附件URL来自当前Actor files.info，认证GET不跟随redirect，检查固定Slack host+files-pri路径，下载前后重验可见消息/权限/停止。网络none默认；显式bridge是包括可路由本地网的联网，不虚称仅限公网；review seat Broker强制none。工具链由固定镜像提供，environment.info告知实际配置，镜像不自动下载。
