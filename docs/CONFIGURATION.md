# 运行配置

下表列出源码开发入口支持的环境变量，启动步骤见[本地开发](DEVELOPMENT.md)。生产使用控制面镜像/Compose 与 node 完整包；控制面配置见[控制面部署](CONTROL_PLANE_DEPLOYMENT.md)，节点配置与 `mate node` 操作见[用户服务说明](node/NODE_SERVICE.md)和[运行与运维](OPERATIONS.md)，包装决定见 [ADR-0009](adr/0009-lightweight-linux-packaging.md)。所有者在网页管理 Agent、频道、成员和模型服务凭据。两个进程以同一个现有普通账号运行；Mate 不创建账号，也不读取旧部署 JSON 模板。

| 进程   | 环境变量                         | 含义与默认值                                                                                                                |
| ------ | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 控制面 | `MATE_CONTROL_PLANE_DATA_DIR`    | 控制面数据库目录，必须为绝对路径；默认是启动工作目录下的 `data/control-plane`。                                             |
| 控制面 | `MATE_OWNER_PASSWORD_FILE`       | 初始所有者密码文件，必须是绝对路径、仅属主可读的普通文件，内容为 12–1024 UTF-8 字节。首次登录保存密码哈希后不再需要此文件。 |
| 控制面 | `MATE_CONTROL_PLANE_HOST`        | 监听地址；开发默认 `127.0.0.1`，Compose 显式为容器内 `0.0.0.0`，宿主端口仍只发布到 loopback。                               |
| 控制面 | `MATE_CONTROL_PLANE_PORT`        | 监听端口，默认 `8787`；`0` 表示由系统分配端口，启动输出报告实际值。                                                         |
| 控制面 | `MATE_PUBLIC_ORIGIN`             | Web Push 的 VAPID 联系原点；公开使用时设置为所有者访问的 HTTPS 原点。Mate 不配置证书或反向代理。                            |
| 节点   | `MATE_CONTROL_PLANE_URL`         | 必填，控制面的 HTTP、HTTPS、WS 或 WSS 地址；节点连接其 `/api/nodes/connect`。地址不能含凭据、查询或片段。                   |
| 节点   | `MATE_NODE_DATA_DIR`             | 节点身份与操作收据目录，必须为绝对路径；默认是启动工作目录下的 `data/node`。                                                |
| 节点   | `MATE_NODE_AGENT_WORKSPACE_ROOT` | Agent 默认工作区根目录，必须为绝对路径；默认是节点数据目录下的 `agents`。                                                   |
| 节点   | `MATE_NODE_PAIRING_TOKEN`        | 新节点首次连接所需的网页一次性配对令牌；已保存节点身份后不再需要。                                                          |

数据目录和工作区由运行账号持有，控制面数据库和节点身份按私有权限保存。保持启动工作目录与绝对数据路径明确，重启时使用原数据、原节点身份和原工作区。

模型 API key 由控制面保存并直接用于模型请求，不进入节点配置或通信。测试通过控制面专用的依赖注入指定本地 HTTP/SSE provider 和持久提交故障点；这些接缝不作为环境变量或发布配置暴露。
