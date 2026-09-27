import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const operations = readFileSync(resolve("docs/OPERATIONS.md"), "utf8");

it("documents the limited remote receipt query and a manual hold path for separate-time restores", () => {
  expect(operations).toContain("控制面只会向节点查询控制面已知");
  expect(operations).toContain("不会枚举节点收据来发现只存在于较新节点检查点中的额外操作");
  expect(operations).toContain("先在控制面网页的 Agent 页面停用受影响的 Agent");
  expect(operations).toContain(
    "不要在网页点击“复启 Agent”，也不要运行控制面主机的 `release-agent`",
  );
  expect(operations).toContain("systemctl stop mate-node.service");
  expect(operations).toContain("身份冲突无法定位到单个 Agent");
});
