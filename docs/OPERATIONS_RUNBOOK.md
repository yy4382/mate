# Debian 13 运维手册

适用对象：已按 [部署步骤](DEPLOYMENT.md) 安装的 Linux 用户版 Mate。所有 `matectl` 命令由人以 root 在受信终端执行；Agent 的普通 shell 始终以其自身 UID 运行。系统级 Agent 请求另外逐条经 Slack owner 确认，不能用运维命令绕过审批。没有真实 Slack/provider/VPS 验证前，只能说本地合成验收通过。

## 日常检查

```sh
sudo matectl status
sudo matectl logs
sudo matectl doctor
```

`status` 和 `logs` 只读取固定的服务状态、恢复标记与结构化运营记录，不输出原始 journald 文本或秘密。`doctor` 报告安装身份、私人/共享目录和配额是否仍符合配置。Agent 可用自身的 `process.list` / `process.stop` 管理后台任务；owner 的 Slack 控制入口也可列出、停止指定 Agent 的后台任务。Mate 从 systemd 和 `/proc` 读取当前事实，不另建一份可能过时的后台任务表。

## 备份与恢复

先停止主服务，并通过 Agent 或 owner 控制入口停止所有 Mate 管理的 Agent 后台任务；备份/恢复入口也会复查，未停止则拒绝。共享工作目录是 Agent 共同使用的普通 VPS 目录，不包含在 Mate 的私人 memory/SQLite checkpoint 内；按一般文件备份办法单独备份 `/srv/mate/shared`，保留 UID/GID 和权限。

```sh
sudo systemctl stop mate.service
sudo matectl backup before-change
sudo matectl restore older --replace before-change
sudo matectl doctor
sudo systemctl start mate.service
```

`backup NAME` 在 `/var/backups/mate/NAME` 保存 SQLite 与每位 Agent 私人 home，并最后发布完成标记。`restore` 会校验目标 checkpoint；若现有状态非空，`--replace CURRENT` 必须指向与当前状态完全匹配的另一份 checkpoint，避免拿过期备份盲目覆盖。恢复支持中断后用相同参数继续；恢复文件归属回到配置的 Agent UID/GID。保留 checkpoint，不要通过删除状态或恢复记录来绕过校验。灾难恢复到全新机器需要先恢复相同 UID/GID 和目录拓扑，再由管理员根据实际保留的数据安排恢复；不应假设换 UID 后仍能直接读取私人资料。

## 代码升级与配置变更

普通代码升级只替换经过验证的 release，不改 SQLite、Agent home、共享目录或配置：

```sh
sudo systemctl stop mate.service
# 先确认 Agent 后台任务已停止，并另取一份 backup。
sudo matectl backup before-upgrade
sudo matectl upgrade /ABSOLUTE/new-mate.deploy.json
sudo matectl doctor
sudo systemctl start mate.service
# 观察后先再次停止服务和后台任务，再选择其一：
sudo systemctl stop mate.service
sudo matectl finalize
# 或：sudo matectl rollback
# 完成检查后 sudo systemctl start mate.service
```

`upgrade` 要求新 spec 的配置与当前安装配置相同；候选发布物通过 release 校验和离线 doctor 后才原子切换 `current`。升级留下 root-only 记录，直到 `finalize` 或 `rollback`；两者均要求服务和后台任务停止。`rollback` 只回退代码版本，因为此升级没有触碰状态。若新代码启动后修改了数据库格式，不能把代码回退视为数据回退：先核验适配性，必要时按 checkpoint 恢复。配置变更需先停机、备份并使用明确的 `mate migrate OLD_CONFIG NEW_CONFIG BACKUP` 离线流程；现有 Agent 的 UID/GID/home 与共享根不允许通过该流程改变。配置文件和凭证由 root 审核并更新，不随代码升级悄悄替换。

## 停用与原生 smoke

```sh
sudo /usr/bin/node /opt/mate/current/dist/src/deployment/cli.js disable /etc/mate/mate.json
```

停用只停止主服务，保留 Agent 后台任务、私人/共享文件、数据库、checkpoint 和发布物；如需结束后台任务，明确从 `process.list` 识别并逐项停止。

在 Debian 13 上做少量原生 smoke：使用 `setpriv --reuid=UID --regid=GID --clear-groups` 分别以两位 Agent 身份尝试读自己的和同伴的 `MEMORY.md`、写自己的和同伴的共享目录、读 `/var/lib/mate/state` 与 `/etc/mate/mate.env`、控制 `mate.service`。预期自己的私人资料可读写，同伴私人资料和 Mate 控制面不可达；共享资料可读，只有自己的目录可写。再由 Agent 启动 `sleep` 一类可停止的长任务，检查列表、停止与列表消失。使用合成数据，不触碰真实私人 memory；记录 UID、命令、退出码，不记录秘密正文。此项是目标机验收，不由 macOS 测试声称完成。
