import { expect, it } from "vitest";
import { systemErrorCode } from "../src/system-error.js";

it("reads string codes on Node errors and structurally equivalent native errors", () => {
  expect(systemErrorCode(Object.assign(new Error("missing"), { code: "ENOENT" }))).toBe("ENOENT");
  expect(systemErrorCode({ code: "EPERM" })).toBe("EPERM");
});

it("leaves unexpected thrown values without an errno code", () => {
  for (const error of [undefined, null, "ENOENT", 1, false, {}, { code: 1 }, new Error("missing")])
    expect(systemErrorCode(error)).toBeUndefined();
});
