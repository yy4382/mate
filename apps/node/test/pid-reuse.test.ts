import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { connectedNode, eventually, linux, textOf } from "./support.ts";

/**
 * Forcing Linux to hand a recorded PID to another process needs a PID namespace whose next PID the test may set. An
 * unprivileged user namespace gives that where the host allows it (the `pnpm test:linux` container does).
 */
const canChoosePids =
  linux &&
  spawnSync("unshare", [
    "-rpf",
    "--mount-proc",
    "sh",
    "-c",
    "echo 99 > /proc/sys/kernel/ns_last_pid",
  ]).status === 0;

/** Set by `pnpm test:linux`, whose container is meant to allow it: there a missing capability fails, not skips. */
const required = process.env["MATE_REQUIRE_PID_NAMESPACE"] === "1";

describe("node process groups and PID reuse (MODULE_TESTS 8.1)", () => {
  it.runIf(canChoosePids || required)(
    "never kills an unrelated process that was given the ID of a group the node recorded",
    async () => {
      expect(canChoosePids, "this run must be able to choose PIDs in a PID namespace").toBe(true);
      // The node runs as the second process of its own PID namespace; the shell that is its init reaps orphans and
      // keeps the namespace, and so the unrelated process, alive for a while after the node exits.
      const node = await connectedNode({
        launch: (argv) => [
          "unshare",
          "-rpf",
          "--mount-proc",
          "sh",
          "-c",
          `"$@"; echo node-exited >&2; sleep 5`,
          "sh",
          ...argv,
        ],
      });
      const { agentId, workspace } = await node.agent();
      const run = async (command: string) => {
        const result = await node.run(agentId, "bash", { command });
        expect(result.isError, textOf(result)).toBe(false);
        return textOf(result);
      };

      // The command returns while its background still runs, so the node keeps its group to stop at shutdown.
      expect(
        await run("sleep 30 > /dev/null 2>&1 & echo $$ > group.pid; echo $! > member.pid"),
      ).toContain("still running");
      const group = Number(readFileSync(join(workspace, "group.pid"), "utf8"));
      // The group ends without the node seeing it, and its ID is free again.
      await run(`kill -KILL $(cat member.pid); while [ -e /proc/${group} ]; do sleep 0.05; done`);
      // An unrelated process gets exactly that ID and leads a group of its own with it.
      await run(
        `echo ${group - 1} > /proc/sys/kernel/ns_last_pid; ` +
          `setsid sh -c 'while :; do touch alive; sleep 0.1; done' > /dev/null 2>&1 < /dev/null & ` +
          `echo $! > stranger.pid`,
      );
      expect(
        Number(readFileSync(join(workspace, "stranger.pid"), "utf8")),
        "the unrelated process reuses the recorded group ID",
      ).toBe(group);

      // Shutting down stops every group the node recorded, which includes that ID.
      void node.run(agentId, "bash", { command: "kill -TERM $PPID" }).catch(() => {});
      await eventually(() => node.stderr().includes("node-exited"), "the node exits");
      const before = statSync(join(workspace, "alive")).mtimeMs;
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(
        statSync(join(workspace, "alive")).mtimeMs,
        "the unrelated process still runs after the node's shutdown",
      ).toBeGreaterThan(before);
    },
  );
});
