import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
};

it("exposes the Linux-user web control plane without superseded deployment paths", () => {
  expect(manifest.scripts["start:control-plane"]).toBe("node dist/src/control-plane/main.js");
  expect(manifest.scripts.deploy).toBe("node dist/src/deployment/cli.js");
  expect(manifest.scripts).not.toHaveProperty("config:check");
  expect(Object.keys(manifest.dependencies).filter((name) => name.startsWith("@slack/"))).toEqual(
    [],
  );
  for (const path of [
    "src/main.ts",
    "src/slack",
    "src/local",
    "src/usage",
    "mate.example.json",
    "mate.local.example.json",
  ])
    expect(existsSync(resolve(path)), path).toBe(false);
});
