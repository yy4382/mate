# 完整 Linux node 包与薄 bootstrap

同一发布版本的 node 完整包包含管理 CLI、专用 Node 24、node 程序、生产依赖、SQLite/文件锁原生模块及重命名辅助程序。VPS 不需要系统 Node、pnpm 或编译器。唯一管理入口是 `~/.local/bin/mate`；专用 Node 只启动 Mate，不加入系统 PATH，也不替换 Agent 命令的工具环境。

## 本地构建（不发布）

在有常规 Docker/Buildx 的构建机器上，从仓库根运行。开发依赖仍使用锁定的 pnpm；容器构建原生模块，运行宿主不编译。

```sh
pnpm build:bundle:node 0.1.0 x64 dist/node-bundles
pnpm build:bundle:node 0.1.0 arm64 dist/node-bundles
```

输出包括 `mate-node-0.1.0-linux-x64.tar.gz`、`mate-node-0.1.0-linux-arm64.tar.gz`、`SHA256SUMS` 和 `bootstrap.sh`。构建不会发布 GitHub Release、上传镜像或启动服务。原锁文件与原相对 workspace 布局用于离线冻结生产安装；最终包中没有源码 checkout 链接、开发依赖、系统软件安装步骤或 pnpm。

仓库另有独立 `Node package build` workflow（`.github/workflows/node-package-build.yml`），使用预配的 Ubuntu 24.04 原生 x86_64 hosted runner 构建 node 完整包。它只有仓库内容读取权限，不发布 Release 或镜像；成功产物作为私有 Actions artifact 保留 3 天，包含 `SOURCE_COMMIT` 供下载者核对构建提交。通过 `feat/linux-lightweight-deployment` 分支的包装相关 push 或指定明确版本的手动操作触发。

`bundle.json` 记录完整包版本、专用 Node 版本、架构、构建系统以及扫描全部 ELF 文件得出的最高 GLIBC、GLIBCXX 和 CXXABI 符号要求。它不是只看 Node 官方二进制得到的估计。构建还用包内 Node 实际加载 SQLite、加解文件锁并执行重命名；安装时重复完整文件校验和原生预检。

目标系统仅为 Ubuntu 24.04、Debian 13 的 x86_64/arm64，元数据的 `targetSystems` 记录目标系统。

## 仅安装管理 CLI

使用现有普通账号，选择明确发布版本，不使用 `latest`。默认完整程序在 `~/.local/lib/mate-node/versions/<版本>`，管理入口指向该包的 `bin/mate`。下面的 SHA-256 必须来自可信的本地构建输出或对应私有 Release 的 `SHA256SUMS`。

```sh
sh ./bootstrap.sh --version 0.1.0 \
  --package ./mate-node-0.1.0-linux-arm64.tar.gz \
  --sha256 '<该包的64位SHA-256>'
~/.local/bin/mate --version
```

bootstrap 先校验包 SHA-256，拒绝路径穿越、链接和特殊文件，安全解包到临时目录，再用包内 Node 调用同一 CLI 安装管理入口。下载、校验、平台、原生依赖、文件冲突或可写性预检失败均不会替换既有入口或数据。CLI 拒绝 root，也不覆盖非 Mate 入口、同名单元或损坏的已安装包。损坏必须如实修复，不能靠重新运行 bootstrap 悄悄替换一半程序。

有预先安装的 `gh` 下载工具时，也可用本仓库私有 GitHub Release 的 `v<版本>` 标签取得明确版本。临时 `GH_TOKEN` 或 `GITHUB_TOKEN` 只用于本次获取，bootstrap 不保存登录配置；进入实际 CLI 前删除这两个变量及 GitHub Enterprise 对应变量。下载失败输出不会转发可能含凭据的工具诊断。没有 `gh` 时，使用本地包即可；Mate 不安装下载工具。

```sh
# 由自己的临时鉴权机制提供 GH_TOKEN，不把凭据写入此文件或 Mate 配置。
sh ./bootstrap.sh --version 0.1.0
unset GH_TOKEN GITHUB_TOKEN
~/.local/bin/mate --version
```

用户自行把 `~/.local/bin` 加入 PATH；bootstrap 不修改 shell profile。绝对入口始终可用。管理 CLI 安装不要求 user manager，也不创建 node 配置、数据、用户单元或后台进程。node 服务命令由 `mate node install/start/stop/restart/status/logs` 管理，首次私有配置与用户服务步骤见 [用户服务说明](NODE_SERVICE.md)；bootstrap 不调用 systemctl/journalctl、不启停服务。

已有 node 用户单元时，同版 bootstrap 只校验完整包并修复管理入口，不修改单元和配置。单元必须明确引用同版包内 Node 与 node 入口；不同版本请求拒绝并提示 `mate node update`。公共入口或程序损坏时，需要使用已校验的本地包内同一 CLI 执行恢复命令；不能引入第二套 shell 更新逻辑。包内 CLI 位于 `mate-node/app/apps/node/dist/management/cli.js`，运行时位于 `mate-node/node/bin/node`，后续管理命令使用这两个绝对路径。
