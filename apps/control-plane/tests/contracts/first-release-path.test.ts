import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(resolve("../../package.json"), "utf8")) as {
  scripts: Record<string, string>;
  dependencies?: Record<string, string>;
};

it("exposes the Linux-user web control plane without superseded deployment paths", () => {
  expect(manifest.scripts["start:control-plane"]).toBe("node apps/control-plane/dist/main.js");
  expect(manifest.scripts["start:node"]).toBe("node apps/node/dist/main.js");
  expect(manifest.scripts).not.toHaveProperty("config:check");
  expect(
    Object.keys(manifest.dependencies ?? {}).filter((name) => name.startsWith("@slack/")),
  ).toEqual([]);
  for (const path of [
    "src/main.ts",
    "src/slack",
    "src/local",
    "src/usage",
    "mate.example.json",
    "mate.local.example.json",
  ])
    expect(existsSync(resolve("../..", path)), path).toBe(false);
});

it("owns the Pi loop in the control plane and ships no node model runtime or protocol", () => {
  for (const name of [
    "model-identity",
    "model-process",
    "model-worker",
    "agent-runner",
    "session-compaction",
  ])
    for (const path of [`../node/src/nodes/${name}.ts`, `../node/dist/nodes/${name}.js`])
      expect(existsSync(resolve(path)), path).toBe(false);
  for (const name of ["session-record", "session-transport"])
    for (const path of [
      `../../packages/protocol/src/${name}.ts`,
      `../../packages/protocol/dist/${name}.js`,
    ])
      expect(existsSync(resolve(path)), path).toBe(false);
  for (const path of ["../node/package.json", "../../packages/protocol/package.json"]) {
    const packageManifest = JSON.parse(readFileSync(resolve(path), "utf8"));
    expect(packageManifest.dependencies).not.toHaveProperty("@earendil-works/pi-agent-core");
    expect(packageManifest.dependencies).not.toHaveProperty("@earendil-works/pi-ai");
  }
  const control = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
  expect(control.dependencies).toHaveProperty("@earendil-works/pi-agent-core");
  expect(control.dependencies).toHaveProperty("@earendil-works/pi-ai");
  expect(readFileSync(resolve("../../packages/protocol/src/messages.ts"), "utf8")).not.toContain(
    "agent.run",
  );
});

it("keeps no implementation of a Mate-managed account, systemd unit or root service path", () => {
  for (const path of [
    "src/deployment/dual-service.ts",
    "src/deployment/dual-installer.ts",
    "src/deployment/service-lifecycle.ts",
    "src/deployment/coordinated-stop.ts",
    "tests/deployment/dual-service.test.ts",
    "tests/deployment/service-lifecycle.test.ts",
    "tests/deployment/coordinated-stop.test.ts",
    "tests/execution/linux-processes.test.ts",
    "tests/linux/agent-stop-fence.integration.mjs",
  ])
    expect(existsSync(resolve("../..", path)), path).toBe(false);

  // The removed path must not creep back as a string in shipped code either: a systemd scope, a
  // Mate-created account name, or an identity switch are all things this release never does. Test
  // files are not scanned here because they name these strings in order to forbid them, and the
  // existence checks above are what keeps the removed checks themselves from coming back.
  const sources = [...sourceFiles(resolve("src")), ...sourceFiles(resolve("../node/src"))];
  for (const file of sources) {
    const text = readFileSync(file, "utf8");
    for (const forbidden of [
      "/usr/bin/systemd-run",
      "/usr/bin/setpriv",
      "mate-control-plane.service",
      "LoadCredential",
      "User=mate-control",
      "User=root",
      "useradd",
    ])
      expect(text, `${file} contains ${forbidden}`).not.toContain(forbidden);
  }
});

/** Every TypeScript, JavaScript, fixture and template file under one directory. */
function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|json)$/.test(entry.name)) found.push(path);
  }
  return found;
}
