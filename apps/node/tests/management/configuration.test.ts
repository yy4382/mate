import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import { nodeOptionsFromEnvironment } from "../../src/main.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function configurationFixture() {
  const home = mkdtempSync(join(tmpdir(), "mate-node-config-"));
  directories.push(home);
  const directory = join(home, ".config/mate");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, "node.json");
  writeFileSync(
    file,
    JSON.stringify({
      MATE_CONTROL_PLANE_URL: "http://127.0.0.1:8787",
      MATE_NODE_PAIRING_TOKEN: "synthetic-token".repeat(3),
      MATE_NODE_DATA_DIR: join(home, "data"),
      MATE_NODE_AGENT_WORKSPACE_ROOT: join(home, "work"),
    }),
    { mode: 0o600 },
  );
  return { file, directory, home };
}

test("the direct node entry reads the private service configuration without shell environment or cwd", () => {
  const { file, home } = configurationFixture();
  expect(nodeOptionsFromEnvironment({ MATE_NODE_CONFIG_FILE: file })).toMatchObject({
    controlPlaneUrl: "http://127.0.0.1:8787",
    pairingToken: "synthetic-token".repeat(3),
    dataDirectory: join(home, "data"),
    agentWorkspaceRoot: join(home, "work"),
  });
});

test("unsafe or damaged configuration fails without printing its contents", () => {
  const { file, directory } = configurationFixture();
  chmodSync(file, 0o644);
  expect(() => nodeOptionsFromEnvironment({ MATE_NODE_CONFIG_FILE: file })).toThrow("private");
  chmodSync(file, 0o600);
  writeFileSync(file, '{"MATE_NODE_PAIRING_TOKEN":"secret-never-diagnose"');
  expect(() => nodeOptionsFromEnvironment({ MATE_NODE_CONFIG_FILE: file })).toThrow("not valid");
  chmodSync(directory, 0o755);
  expect(() => nodeOptionsFromEnvironment({ MATE_NODE_CONFIG_FILE: file })).toThrow("private");
});
