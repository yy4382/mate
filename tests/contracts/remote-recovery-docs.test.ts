import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const operations = readFileSync(resolve("docs/OPERATIONS.md"), "utf8"),
  configuration = readFileSync(resolve("docs/CONFIGURATION.md"), "utf8");

it("documents the limited remote receipt query and a manual hold path for separate-time restores", () => {
  expect(operations).toContain("控制面只会向节点查询控制面已知");
  expect(operations).toContain("不会枚举节点收据来发现只存在于较新节点检查点中的额外操作");
  expect(operations).toContain("先在控制面网页的 Agent 页面停用受影响的 Agent");
  expect(operations).toContain(
    "不要在网页点击“复启 Agent”，也不要运行控制面主机的 `release-agent`",
  );
  expect(operations).toContain("身份冲突无法定位到单个 Agent");
  expect(operations).toContain("第 25 版起 Mate 没有特权命令审批");
});

it("documents what a completed backup holds and what verify proves for an ordinary account", () => {
  // The owner has to be able to tell a complete backup from leftovers, and to know what a passing
  // verification did and did not establish. Each of these sentences is one half of that contract.
  expect(operations).toContain(
    "`backup` 只用运行账号自己的权限——不需要 root、systemctl 或任何特权审批",
  );
  expect(operations).toContain("一份**完成**的备份是这样一个目录");
  expect(operations).toContain("`complete.json`——清单的校验和。它最后写入");
  expect(operations).toContain("`verify` 证明的是这份备份现在仍然等于它被写下时的样子");
  expect(operations).toContain("控制面数据库里上面那些表都在且能读");
  expect(operations).toContain("校验只读：它不修改备份，也不“修复”失败的结果");
  expect(operations).toContain(
    "备份中断、某个路径读不了、或任何一步失败时，Mate 都不写 `complete.json`",
  );
  // What stops a checkpoint from being taken at all, and what a second maintenance step finds.
  expect(operations).toContain("节点操作收据里还留着已开始但未结算的命令");
  expect(operations).toContain("stateDir/maintenance.lock");
  expect(operations).toContain("会在停服务之前就报错");
  // The repair path must stay reachable, and the recorded-unknown boundary must be stated.
  expect(operations).toContain(
    "`reconcile`、`release-agent` 和 `restore` 正是用来处理无法确认的结果的",
  );
  expect(operations).toContain("不会永久阻止备份");
  // The state a completed backup promises, named the way the owner's own tools name it.
  for (const table of [
    "owner_sessions",
    "owner_agent_session_journal",
    "owner_messages",
    "owner_tasks",
    "owner_reminders",
    "owner_agent_process_operations",
  ])
    expect(operations).toContain(table);
});

it("advertises no installation or upgrade step that needs root, a Mate account or a systemd unit", () => {
  for (const text of [operations, configuration]) {
    for (const forbidden of [
      "sudo install",
      "sudo systemctl",
      "systemctl enable",
      "systemctl start",
      "useradd",
      "setpriv",
      "LoadCredential",
      "User=root",
      "mate-control",
      "/opt/mate",
      "/var/lib/mate-",
    ])
      expect(text, forbidden).not.toContain(forbidden);
  }
  // The one optional process-manager note is one the owner writes for their own account.
  expect(operations).toContain("由所有者自己写一个**以该普通账号运行**的用户级单元");
  expect(operations).toContain("运行身份是那个普通账号，不使用 root，也不由 Mate 安装或控制");
});
