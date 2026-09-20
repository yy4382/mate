# E 权限与执行审核

- 作者 /root；独立 reviewer /root/review_e，fresh context，只读。
- 范围 policy/broker与Jev、execution后端/路径/文件工具、schema v4、policy与真实sandbox tests。
- 初审High：macOS仅杀进程组无法停止detached/setsid；独立真实复现执行返回后继续写入。
- 修复：任意shell改为ContainerBackend（不可变本地镜像、PID namespace、受限挂载/网络/资源），所有结束路径确认删除；SRT只执行固定文件程序并拒绝shell。启动scope清理仅处理本daemon孤儿。
- 复审Medium：exact command grant与执行cwd规范化不一致；共用normalize并测试授权./、执行.。建议关闭Docker日志已采纳。
- 最终独立复审：40普通tests/typecheck PASS、3真实SRT/容器tests PASS（12.25秒），包括setsid正常/abort/timeout、scope隔离清理。无剩余确认阻塞，E gate PASS。
- Jev真实分类准确率/中文、Linux/Windows、实际项目工具链镜像未验证。全部网络/容器测试仅用合成临时目录和本地已有busybox镜像，不拉取镜像或外发消息。
