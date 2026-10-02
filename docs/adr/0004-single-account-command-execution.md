# 单账号运行与普通命令执行

Mate 首版作为单个所有者的普通用户程序运行：控制面、节点和 Agent 命令都使用同一个现有的非 root Linux 账号，模型循环位于控制面。每 Agent Linux 用户、root 节点和 systemd scope 增加了安装与执行复杂度，却不是所有者所需的工作区边界；Mate 因此不创建用户、不切换 UID/GID、不为 Agent 命令创建 systemd 单元，也不提供特权命令审批。[ADR-0009](0009-lightweight-linux-packaging.md) 仅重新引入安装器管理 node 用户服务的有限范围。Agent 的命令作为普通子进程运行；命令中若包含 `sudo`，是否获得 root 权限仅由宿主预先配置的 sudo 规则决定。

每个 Agent 仍有自己的默认工作区和独立逻辑会话。Mate 在 prompt 中提醒不要读同伴工作区，但不设置跨工作区的读取拦截或许可流程；Agent 判断有必要时可以读取。同一 Unix 账号也意味着 Mate 不能承诺用文件权限对 Agent 命令隔离其他工作区、控制面数据或模型凭据。命令取消只能尽力终止子进程；尤其不能保证停止由 `sudo` 派生的 root 进程。
