# 源码导航与类型约定

第一次接触 Mate，可以先看下面的入口，再沿实际请求走向阅读。产品概念以根目录 `CONTEXT.md` 为准，运行和检查命令见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 四个 package

| 位置 | 负责什么 | 建议从哪里开始 |
| --- | --- | --- |
| `apps/web` | 所有者使用的中文网页 | `src/main.tsx`，然后进入相应功能目录 |
| `apps/control-plane` | 登录、持久状态、会话和工具循环、调度与请求路由 | `src/main.ts` 装配，`src/http.ts` 处理 HTTP 与事件流 |
| `apps/node` | 机器连接、Agent 工作区、文件与命令执行、本地收据 | `src/main.ts`，然后看 `src/connection/node-client.ts` |
| `packages/protocol` | 跨 package 的运行时数据契约及其推导类型 | `src/owner.ts`、`src/workspace.ts` 和节点消息、操作契约 |

控制面拥有模型循环，节点不运行模型。一次 run 结束也不表示消息关联的任务已经完成。

## 控制面按领域找代码

- `conversations/`：频道、私信、消息、已读与暂缓、消息关联任务和提醒。`service.ts` 保留事务与业务编排；`contracts.ts` 是请求校验，`rows.ts` 解释数据库查询结果，`tool-contracts.ts` 描述 Agent 能看到的工具。
- `agents/`：Agent 身份、资料、创建与目录；供应商模型的校验仍在控制面，不能带进浏览器。
- `runtime/`：run 调度、模型循环、操作收据与恢复、活动和用量。`session/` 管完整历史和压缩，`tools/` 管工具入口和当前 run 检查；`provider-response.ts` 只解释供应商响应中的结束和用量证据。
- `workspaces/`：文件浏览、下载和 Agent 文件操作的控制面逻辑。`contracts.ts` 和 `results.ts` 分别放请求契约与结果解释；副作用提交顺序留在服务中。
- `attachments/`：附件操作及相应工具描述。
- `nodes/`：控制面的节点目录和连接路由；与 `apps/node` 的机器端代码不同。
- `auth/`、`providers/`、`notifications/`：所有者登录、模型凭据和供应商目录、网页推送。
- `storage/`：数据库初始化与各领域表的装配。领域里的 `schema.ts`、`*-schema.ts` 是 SQL 表定义，与 Zod 的 `contracts.ts` 分工不同。

没有为了缩短文件而引入通用仓储层，也没有把事务拆成通过庞大上下文对象相互调用的小函数。跨领域操作仍应能看清在哪个事务里提交。

## 节点按执行职责找代码

- `connection/`：节点身份、配对、WebSocket 连接及重连。
- `provisioning/`：准备同一运行账号下的 Agent 默认工作区。
- `files/`：文件操作入口、辅助进程、路径检查与原子文件操作。
- `processes/`：普通命令、进程状态、操作运行与持久收据。
- `management/`：完整发布包契约与校验、现有账号目录规则、唯一 CLI 入口安装、私有节点配置和 systemd 用户服务管理；`acquire-bundle.ts` 只获取临时完整包，`update.ts` 在停止事实与管理锁内切换，`repair-bundle.ts` 处理可信原清单下的外部 CLI 同版修复；`deploy/node/` 是离线生产包构建、薄 bootstrap 和实际包外部验收入口。见 [完整 node 包说明](NODE_BUNDLE.md)、[用户服务说明](NODE_SERVICE.md) 与 [停机更新](NODE_UPDATE.md)。

节点卸载由 `management/uninstall.ts` 根据实际单元、入口与包库存继续清理，使用同一管理锁并保留配置与数据；命令恢复和真实服务验收入口见 [卸载说明](NODE_UNINSTALL.md)。

对应测试也按这些目录组织。外部使用节点时，依赖 package 的明确导出；内部移动文件不要求调用方知道新的磁盘路径。

## 网页按用户功能找代码

下面的功能目录都位于 `apps/web/src/features/`。

- `conversations/`：聊天、频道弹窗、消息列表与消息关联任务。
- `agents/`：Agent 页面、资料编辑、草稿与活动展示。
- `workspace/`：工作区浏览、下载操作及状态查询。
- `nodes/`、`tasks/`、`reminders/`：相应管理页面。

页面和相关样式放在同一功能目录。共享登录和请求处理保持独立；跨请求的取消、过期响应和重新连接仍由原有状态边界管理。

## 数据契约如何共用

Zod schema 是需要运行时校验的领域数据的类型来源。`z.infer` 或 `z.output` 表示解析后的值；带默认值或转换的输入使用 `z.input`。本地临时值和简单实现函数优先使用推导，模块接口和需要约束的公共形状保留显式类型。

浏览器使用 `@mate/protocol/owner` 和 `@mate/protocol/workspace`，避免依赖含 Node 专用校验的根导出或供应商 SDK。网页只需要静态形状时使用 `import type`；HTTP 和事件流响应需要实际校验时，使用这些浏览器安全的 Zod 契约及保留额外字段的显示投影。运行时校验会引入 Zod，但不应引入 Node 专用工具或模型 SDK。

数据库查询的参数和行类型写在查询边界；对不可信持久数据或外部结果使用已有 Zod 契约或明确的类型收窄。不要靠 `as` 跳过检查，也不要为了消除一个断言而发明通用框架。

Pi 会话保留供应商扩展字段。会话边界的窄适配不能改成会删掉未知字段的重新构造；变更 Zod schema 时也必须保留原本的严格或宽松行为、默认值、错误映射和恢复含义。

控制面容器交付位于 `deploy/control-plane`：`Dockerfile` 生成生产镜像，`compose.yaml` 仅运行控制面，`compose.initialize.yaml` 只供首次密码初始化，`entrypoint.mjs` 检查普通账号与私有挂载，`build.mjs` 和 `verify.mjs` 是明确版本本地构建及隔离接口验收入口。

`deploy/tests/delivery-smoke.sh` 从实际完整包启动独立镜像/Compose 联通验收；`delivery.mjs` 只用 Node 内置库，经所有者 API 与真实 Pi/节点检查程序和数据，`control-plane-fixture.mjs` 仅在测试 override 注入合成模型 HTTP/SSE 地址。生产配置不导入这些测试文件。真实四平台用户服务命令与证据边界见 [部署验收](DEPLOYMENT_ACCEPTANCE.md)。
