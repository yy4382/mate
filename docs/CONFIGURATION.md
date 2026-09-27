# 部署配置

> **重构中的旧实现说明，不是首版目标配置。** 当前示例仍服务于尚未移除的 root/systemd 路径；新目标见[产品方向](PROJECT_DIRECTION.md)和[单账号执行决定](adr/0004-single-account-command-execution.md)。

当前旧实现的 `mate.deploy.example.json` 包含 `publicOrigin`、`controlPlanePort`、三个数据目录和 `ownerPasswordFile`。这些字段及其权限假设需要随单账号部署路径重写；Agent、频道、成员或模型 API key 不写入部署 JSON。

安装器要求三个数据目录是互不相同的 `/var/lib/mate-*` 绝对路径，密码文件位于 `/etc/mate/`。新节点的配对令牌由所有者在网页生成，暂存在 root 私有 `/etc/mate/node.env`；配对完成后节点凭其已保存身份重连。所有者登录网页后管理 Agent、成员关系和模型服务凭据。具体安装与升级步骤见[Debian 部署与运维](OPERATIONS.md)。
