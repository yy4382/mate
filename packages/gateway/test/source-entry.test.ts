import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("the gateway package run from source", () => {
  it("loads its public entry under plain Node, as the control plane's main does", () => {
    const loaded = execFileSync(
      process.execPath,
      [
        "--conditions=mate-source",
        "--input-type=module",
        "--eval",
        'const gateway = await import("@mate/gateway"); console.log(typeof gateway.createNodeGateway);',
      ],
      { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" },
    );
    expect(loaded.trim()).toBe("function");
  });
});
