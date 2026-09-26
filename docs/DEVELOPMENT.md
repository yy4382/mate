# 本地开发与验证

使用 Node 24 和 pnpm 10.33.0。运行 `pnpm install --frozen-lockfile`、`pnpm check`、`pnpm typecheck`。`pnpm build` 将控制面与节点编译到 `dist/src`，将网页写入 `dist/web`。首版部署配置见[配置说明](CONFIGURATION.md)，Debian 13 的服务与 Caddy 安装见[运维说明](OPERATIONS.md)。

控制面本地启动需要一个只有当前用户可读的初始密码文件（12–1024 UTF-8 字节）和一个绝对数据目录：

```sh
export MATE_CONTROL_PLANE_DATA_DIR=/ABSOLUTE/private/control-plane
export MATE_OWNER_PASSWORD_FILE=/ABSOLUTE/private/owner-password
pnpm start:control-plane
pnpm dev:web
```

浏览器打开 `http://127.0.0.1:5173`，Vite 将 `/api` 转给本机控制面。PWA 注册和授权入口可在安全的 localhost 上检查；真实公网 Push 送达、域名证书和 Caddy WSS 须在 HTTPS 部署上验证。Web Push 的仓库测试只注入本地伪发送器，验证通知选择、去重、失败不回滚和落点；它不向第三方服务发送通知。

Linux 节点要求 root、`setpriv`、systemd 和 Agent 用户切换。macOS 单元测试和本地网页检查只验证应用逻辑，不构成真实 Linux 权限与进程隔离证据。已完成的隔离容器 UID/GID 测试与待做的 Debian 13 原生 systemd、Caddy、升级和恢复检查须分别记录；不要把模拟宿主结果标为原生通过。
