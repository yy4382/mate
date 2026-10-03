import { expect, it } from "vitest";
import { confirmedFileFailure } from "../../../src/workspaces/results.js";

it("uses the stable permission code despite misleading unknown/missing diagnostics", () => {
  const error = confirmedFileFailure(
    7,
    "operation_unknown: missing file changed",
    "permission_denied",
  );
  expect(error).toMatchObject({ code: "permission_denied", status: 403 });
  expect(error.message).toContain("没有读取此文件的权限");
  expect(error.message).toContain("7");
});

it("keeps an explicitly unknown result unknown even when diagnostics describe a missing file", () => {
  expect(confirmedFileFailure(1, "ENOENT: no such file", "operation_unknown")).toMatchObject({
    code: "operation_unknown",
    status: 409,
  });
});
