// Build B's delivery from this checkout, then run the same synthetic scenario functions.
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../../..", import.meta.url));
const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const image = `mate-a-scenarios:${sha.slice(0, 12)}-${randomUUID()}`;
let current;
let cancelled;
function interrupt(signal) {
  cancelled = signal;
  if (current?.pid) {
    try {
      process.kill(-current.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}
const onInterrupt = () => interrupt("SIGINT");
const onTerminate = () => interrupt("SIGTERM");
process.once("SIGINT", onInterrupt);
process.once("SIGTERM", onTerminate);
async function run(program, args, environment = process.env) {
  if (cancelled) throw new Error(`Container driver cancelled by ${cancelled}`);
  const child = spawn(program, args, {
    cwd: root,
    env: environment,
    stdio: "inherit",
    detached: true,
  });
  current = child;
  try {
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
  } finally {
    current = undefined;
  }
}
let firstFailure;
try {
  const built = await run(process.execPath, [
    "deploy/control-plane/build.mjs",
    `0.1.0-scenario-${sha.slice(0, 12)}`,
    image,
  ]);
  if (built.code !== 0) throw new Error(`Delivery image build failed: ${JSON.stringify(built)}`);
  const tests = await run(
    "pnpm",
    [
      "--filter",
      "@mate/control-plane",
      "exec",
      "vitest",
      "run",
      "--config",
      "vitest.container.config.ts",
    ],
    { ...process.env, MATE_SCENARIO_IMAGE: image },
  );
  if (tests.code !== 0) throw new Error(`Container scenarios failed: ${JSON.stringify(tests)}`);
} catch (error) {
  firstFailure = error;
} finally {
  process.removeListener("SIGINT", onInterrupt);
  process.removeListener("SIGTERM", onTerminate);
  try {
    execFileSync(
      process.execPath,
      [
        "apps/control-plane/tests/support/environment/scenario-cleanup.mjs",
        "--root",
        "artifacts/scenarios",
      ],
      { cwd: root, stdio: "inherit", timeout: 90_000 },
    );
  } catch (error) {
    console.error("Manifest resource cleanup failed", error);
    firstFailure ??= error;
  }
  try {
    const ids = execFileSync("docker", ["image", "ls", "--quiet", "--no-trunc", image], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
    if (ids) execFileSync("docker", ["image", "rm", image], { stdio: "inherit", timeout: 30_000 });
  } catch (error) {
    console.error("Container resource cleanup failed", error);
    firstFailure ??= error;
  }
}
if (firstFailure) {
  console.error(firstFailure);
  process.exitCode = 1;
}
