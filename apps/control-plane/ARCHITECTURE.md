# 控制面外壳（`@palace/control-plane`）

> 总览见 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)。环境变量和部署见 [DEPLOYMENT](../../docs/DEPLOYMENT.md)。测试见 [TESTS.md](TESTS.md)。

## 职责

把各模块组装成一个进程，负责人类的登录和管理、登录会话、HTTP 路由、事件流、推送发送器和前端静态文件。入口是 `startControlPlane(options)`，`main.ts` 从 `PALACE_*` 环境变量读选项，收到 SIGTERM 或 SIGINT 时关闭后退出。

## 组装

先打开外壳在控制库里的表（模块 `shell`），再打开聊天 app、`Humans`，第一次启动时创建第一个人类，建网关并把 `/api/nodes/connect` 的 upgrade 交给它，最后 `openAdmin`。关闭时先停 HTTP 服务（事件流随之结束），再依次关闭管理模块、网关、聊天 app 和外壳的表。启动中途失败时，已打开的部分按相反顺序关闭。

## 人类与登录

谁能登录由外壳的 `humans` 表决定：每行一个人类，以聊天账号的 `externalId` 为键，带角色（`admin` 或 `member`）、scrypt 密码哈希和是否有效。显示名和 handle 在聊天账号里。聊天 app 不知道登录和角色，两边靠 `externalId` 对上。

- **登录。** handle 加密码。外壳先用 `chat.findHuman` 找到人类，再校验密码。handle 不存在、属于 Agent 或人类已停用，都和密码错误一样回 401 `wrong-password`，并照样对一个假哈希做一次 scrypt，所以回答和耗时都不泄露 handle 是否存在。
- **限流。** 同时最多 2 个密码校验，其余先进先出排队，队列最长 64，排队超过 10 秒回 429。不做锁定，也不按客户端计数，所以连续输错多少次，正确的密码都进得来。代价是有人持续填满队列时，正确的登录也可能回 429，重试即可，已有会话不受影响。
- **开会话。** 插入会话的语句要求这个人类仍有效、密码哈希和角色仍是校验时的那一份，所以排队期间被改密码、改角色或停用的人，这次登录回 401。cookie 是 `__Host-mate_session`（`HttpOnly; Secure; SameSite=Lax`），库里只存令牌的 SHA-256。会话 30 天有效，不随使用延长，跨重启保留。
- **会话是权限的快照。** 改角色、重置密码、停用都结束这个人类的全部会话（改自己的密码时保留当前这个），所以降级的管理员开着的事件流在下一个事件或心跳时以 `login` 结束。
- **第一次启动。** `humans` 表为空时，从初始密码文件和 `initialHandle` 建聊天账号（`externalId: "human:initial"`）再插入管理员行。两步都以这个固定的 `externalId` 为键，停在两步之间时下次启动会补完。之后不再读这个文件。
- **人类的管理。** 每个人改自己的显示名、handle 和密码。管理员还能添加人类、改角色、重置密码和停用。任何时候至少有一个有效管理员，降级或停用最后一个回 409 `last-admin`。停用是永久的：先在外壳标记无效并删除会话，再停用聊天账号，中途崩溃时重做同一请求会补完。添加人类以 `requestId` 幂等（`externalId` 是 `human:request:<requestId>`），先建聊天账号再插入外壳行。

## 路由

路由表在 `src/routes.ts`、`src/human-routes.ts` 和 `src/avatar-routes.ts`。

- 除登录、退出和 webhook 投递外，`/api/*` 都要登录。会话在整个请求体收完之后才查，所以请求体在退出之后才收完的请求同样回 401。
- `/api/chat/*` 一个路由对应聊天 app 的一个操作，账号固定为请求者自己。发送和任务操作总是关闭新鲜度检查（聊天规则 2）。
- `/api/admin/*` 和 `/api/humans` 只给管理员，普通人类在解析请求体之前就得到 403 `admin-only`。`/api/admin/*` 一个路由对应管理模块的一个操作。
- `POST /api/webhooks/:id` 不用登录会话，用 `Authorization: Bearer <密钥>`，成功回 202。所有鉴权失败都回相同的 401 `invalid-webhook`，没有限流。
- 头像按内容版本给出 URL，返回 `immutable` 缓存一年，换头像就换 URL。
- 页面：前端目录里的静态文件不要登录；`/app` 下的页面未登录时跳到 `/login?next=`；其余路径回 `index.html`，由前端路由。没有前端目录时页面回 404，API 照常。

**跨站防护。** 请求体必须是 `application/json`，否则回 415，因为别的站点的表单或不预检的 `fetch` 发不出这种请求。带 `Origin` 的非 GET 请求要求 `Origin` 的 host 等于 `Host`，否则回 403 `cross-origin`。没有 `Origin`（脚本、curl）的请求放行。

**拒绝的形状。** 请求体原样交给聊天 app 或管理模块解析。拒绝回 `{ error, message }`，`error` 就是模块的 `reason`，每个 reason 对应固定的状态码。创建 Agent 在文件改名之前失败回 500 `creation-failed` 并带 `agentId`，客户端用它重做。

## 事件流

用 SSE。`GET /api/chat/events?cursor=` 把 `liveEvents` 读到的每一批作为一个 `events` 事件发出，SSE id 就是这批的游标，所以 EventSource 重连带着 `Last-Event-ID` 正好接上。读完一轮后等 `watchLive` 的信号。游标接不上时发 `resnapshot` 并关闭。

每个事件发出前、每次读聊天 app 前都查一次会话，会话结束就发 `login` 并关闭。空闲时每 25 秒发一行注释作心跳，心跳前同样查会话。`GET /api/admin/agents/:id/events` 是 `watchAgent` 的流，观察结束时发 `ended`，会话规则相同。

## 推送发送器

**Web Push。** VAPID 密钥对在第一次启动时生成并存在外壳的表里，之后不变，因为换密钥会让所有订阅失效。`PushSender` 用 `web-push` 发出（TTL 一天，超时 10 秒），按 RFC 8030 把回答交回聊天 app：2xx 送达，404 和 410 失效，408、429、5xx 重试，其他拒绝。

**APNs。** `apns.ts` 用 `@parse/node-apn` 直接连 APNs，不经过 Expo 推送服务。不配置时 Web Push 照常，原生登记回 503，环境不匹配回 409，取消登记不要求 APNs 开启。

- 单次发送总期限 10 秒，库内重试关闭，重试交给聊天 app 的队列。
- 只有 `BadDeviceToken`、`Unregistered` 和 `DeviceTokenNotForTopic` 算失效。BadPath 和 provider 配置错误是拒绝，保留订阅。429、5xx 和连接失败（包括过期的 provider token）重试。
- expiry 固定为消息时间加一天，重试不延长。collapse ID 用消息的 tag。
- 系统提示只有通用文案，用 `loc-key` 指向 app 打包的中英文字符串，数据带定位和 binding，不含正文。

APNs 私钥可以来自文件或标准输入。标准输入只读进内存，入口解析并验证 EC P-256 私钥后交给 provider。凭据解析错误在这个边界脱敏，其他启动错误保留原诊断。

## 契约

登录与人类的契约（`Role`、`HumanView`、`LoginInput`、`LoginResult`）在 `@palace/control-plane/contracts`。这个入口只依赖 Zod 和 `@palace/chat/contracts`，不带 Node，所以网页和移动端都能导入。

## 持久化

控制库 `data/control.sqlite` 的 `shell` 模块表：`humans`、`sessions`（令牌哈希）和 VAPID 密钥。
