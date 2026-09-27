import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  createSystemctlRunner,
  ProcessWaitInterruptedError,
} from "../../src/execution/linux-processes.js";

it("kills the real systemctl wait when it is cancelled or exceeds its timeout", async () => {
  const root = mkdtempSync(join(tmpdir(), "mate-systemctl-wait-")),
    marker = join(root, "finished");
  try {
    const runner = createSystemctlRunner("/bin/sh");
    await expect(runner(["-c", "printf ready"])).resolves.toEqual({
      code: 0,
      stdout: "ready",
      stderr: "",
      truncated: false,
    });
    await expect(runner(["-c", "exit 3"])).resolves.toMatchObject({ code: 3 });
    const controller = new AbortController();
    const cancelled = runner(["-c", `sleep 0.2; touch ${marker}`], {
      signal: controller.signal,
      timeoutMs: 5000,
    });
    setTimeout(() => controller.abort(), 20);
    const cancelStarted = Date.now();
    await expect(cancelled).rejects.toBeInstanceOf(ProcessWaitInterruptedError);
    expect(Date.now() - cancelStarted).toBeLessThan(2000);
    const timedOut = await runner(["-c", `sleep 0.2; touch ${marker}`], {
      timeoutMs: 20,
    }).catch((error: unknown) => error);
    expect(timedOut).toBeInstanceOf(ProcessWaitInterruptedError);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(existsSync(marker)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("refuses to parse systemctl output that exceeded the capture limit", async () => {
  const runner = createSystemctlRunner("/bin/sh");
  const long = await runner(["-c", "head -c 200000 /dev/zero | tr '\\000' x"]);
  expect(long.truncated).toBe(true);
  expect(long.code).toBe(0);
  expect(long.stdout).toHaveLength(65536);
});
