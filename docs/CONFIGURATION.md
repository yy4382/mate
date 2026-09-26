# 部署配置

`mate.deploy.example.json` 是首版唯一受支持的部署配置示例。`publicOrigin` 是所有者访问 Mate 的 HTTPS 原点；`controlPlanePort` 只在 `127.0.0.1` 监听；三个数据目录分别保存控制面事实、节点身份与收据、Agent 私人 home；`ownerPasswordFile` 是首次登录使用的 root 私有密码文件。配置只包含启动地址、目录和初始凭据位置，不包含 Agent、频道、成员或模型 API key。

安装器要求三个数据目录是互不相同的 `/var/lib/mate-*` 绝对路径，密码文件位于 `/etc/mate/`。新节点的配对令牌由所有者在网页生成，暂存在 root 私有 `/etc/mate/node.env`；配对完成后节点凭其已保存身份重连。所有者登录网页后管理 Agent、成员关系和模型服务凭据。具体安装与升级步骤见[Debian 部署与运维](OPERATIONS.md)。
