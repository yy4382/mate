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
