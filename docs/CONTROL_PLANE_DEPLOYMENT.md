# 控制面 Docker 与 Compose

控制面镜像带已构建的中文网页、PWA 和生产依赖。VPS 只运行镜像，不需要 Node、pnpm、源码或编译器。Compose 只有 `control-plane` 服务；node 使用宿主账号的环境与文件，工作区、node 数据、整个 home 和 Docker socket 都不挂载进控制面。

## 前提与产物

使用已经安装并允许当前普通账号操作的常规 Docker Engine 和 Docker Compose。Mate 不安装 Docker、不改变组权限或守护进程配置。容器使用宿主账号的非零 UID/GID；rootless 和 userns-remap 不属于本文运行配置。

发布后使用明确版本的私有镜像 `ghcr.io/yy4382/mate-control-plane:<版本>` 或固定 digest，并预先自行完成 registry 登录。这里只提供本地构建，不自动推送镜像、创建 Release 或向外发布。控制面与 node 完整包选择同一发布版本。

在构建机器从目标 checkout 执行（不在 VPS 上构建）：

```sh
pnpm install --frozen-lockfile
pnpm build:image:control-plane 0.1.0-test mate-control-plane:0.1.0-test
```

构建按 `pnpm-lock.yaml` 安装，在 Debian bookworm/Node 24.21.0 内编译原生依赖及网页，再生成独立的生产依赖目录。版本参数必填，镜像记录版本和构建时的 Git revision；工作区有未提交修改时，revision 仍是当前 HEAD。`docker build --platform linux/amd64` 或 `linux/arm64` 使用同一 Dockerfile 构建目标架构。

## 首次启动

以下命令由运行 Mate 的现有普通账号执行。提前准备私有目录和初始密码文件，Compose 不创建缺失的 bind 源路径，不以 root 初始化或 chown：

```sh
install -d -m 0700 "$HOME/.local/share/mate/control-plane" "$HOME/.config/mate"
umask 077
cat > "$HOME/.config/mate/owner-password"
chmod 0600 "$HOME/.config/mate/owner-password"
```

输入 12–1024 UTF-8 字节的初始密码后按 Ctrl-D。把交付中的 `compose.yaml`、`compose.initialize.yaml` 保存到同一工作目录，创建自己的私有 `.env`（示例见 `deploy/control-plane/.env.example`），设置实际绝对路径和 UID/GID：

```sh
umask 077
cat > .env <<EOF_ENV
MATE_CONTROL_PLANE_IMAGE=mate-control-plane:0.1.0-test
MATE_UID=$(id -u)
MATE_GID=$(id -g)
MATE_CONTROL_PLANE_DATA_DIR=$HOME/.local/share/mate/control-plane
MATE_OWNER_PASSWORD_FILE=$HOME/.config/mate/owner-password
MATE_PUBLIC_ORIGIN=https://mate.example.org
EOF_ENV

docker compose -f compose.yaml -f compose.initialize.yaml up -d
```

私有目录须属于该账号 UID/GID、仅属主有权限并可读写进入；密码须是同 UID/GID 的私有普通文件。镜像启动检查不合格输入并输出非零退出及明确错误；`up -d` 只表示容器创建请求完成，须继续检查 `docker compose logs`、网页与登录结果。端口固定发布到宿主 `127.0.0.1:8787`，占用时 `up` 明确失败。不会尝试其它端口或公网地址。容器内部监听 `0.0.0.0:8787`，同机 node 主动连接 `http://127.0.0.1:8787/api/nodes/connect`；node 配置值仍为 `MATE_CONTROL_PLANE_URL=http://127.0.0.1:8787`。

`curl http://127.0.0.1:8787/api/status` 返回运行状态。公开浏览器通过宿主自己配置的 HTTPS 代理访问；Mate 的会话 cookie 要求 HTTPS，loopback HTTP 适合状态和脚本接口检查。Compose 不捆绑代理或证书，`MATE_PUBLIC_ORIGIN` 与 Web Push 沿用[运行配置](CONFIGURATION.md)。

## 移除初始密码

首次成功登录把密码哈希存入 `control-plane.sqlite` 后，去掉初始化 override 并重新创建容器，再删私有密码文件和 `.env` 中的 `MATE_OWNER_PASSWORD_FILE` 行：

```sh
docker compose -f compose.yaml up -d --force-recreate
rm "$HOME/.config/mate/owner-password"
```

以后只使用 `compose.yaml`；它没有密码挂载或密码环境变量。重新登录使用原密码，容器替换和同版本镜像更新读取同一 bind 目录内的 `control-plane.sqlite`、`durable/<Agent ID>.sqlite` 与 `attachments`。原生会话及其 WAL/SHM 已包含在现有挂载中，无需新 volume 或服务；node 的工作区和凭据边界不变。不能仅凭 `/api/status` 可达就删除首次密码：必须先成功登录完成哈希保存。

## 启停、更新、日志与卸载

```sh
docker compose -f compose.yaml logs --tail 100 -f
docker compose -f compose.yaml stop
docker compose -f compose.yaml start
```

标准 `unless-stopped` 策略恢复异常退出的容器；显式 `stop` 或 `down` 后保持停止，直到再次 `start` 或 `up`。Docker 守护进程的启动与日志保留是宿主设置，Mate 不修改它们。不能为了验证策略去重启正在使用的 Docker。

维护时先停止 node，再停止控制面。选择兼容数据格式的同版 node 包和控制面镜像，把 `.env` 中镜像改成明确版本，获取镜像后用 `docker compose -f compose.yaml create --force-recreate` 替换容器，保持停止。随后显式执行 `docker compose -f compose.yaml start` 启动控制面，确认可登录后再显式启动 node。保留 bind 目录，包装不删除或迁移陌生格式的数据库；启动失败从容器日志查看原因。

```sh
docker compose -f compose.yaml down
```

`down` 移除容器与本项目网络，保留宿主控制面数据库、凭据和附件；不删除 node、工作区、Docker 或镜像缓存。
