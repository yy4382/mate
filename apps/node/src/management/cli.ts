import { bootstrapInstall, requireOrdinaryAccount } from "./install-entry.js";
import {
  assertDedicatedRuntime,
  nativeProbe,
  probeBundle,
  runningBundleDirectory,
  verifyBundle,
} from "./bundle.js";
import { manageNode, nodeServiceCommands } from "./service.js";
import { nodePaths } from "./paths.js";

async function main() {
  requireOrdinaryAccount();
  const directory = runningBundleDirectory();
  assertDedicatedRuntime(directory);
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--native-probe") {
    await nativeProbe(directory);
    return;
  }
  if (args.length === 1 && args[0] === "--version") {
    const metadata = verifyBundle(directory);
    probeBundle(directory, metadata);
    process.stdout.write(`${metadata.version}\n`);
    return;
  }
  if (args.length === 3 && args[0] === "--bootstrap-install" && args[1] && args[2]) {
    const metadata = await bootstrapInstall(args[1], args[2]);
    process.stdout.write(
      `Mate ${metadata.version} CLI installed at ${process.env.HOME ?? "~"}/.local/bin/mate. No node service was installed or started.\n`,
    );
    return;
  }
  if (args[0] === "node" && args[1] && nodeServiceCommands.includes(args[1])) {
    const command = args[1];
    let lines = 100,
      follow = false;
    const options = args.slice(2);
    if (command !== "logs" && options.length)
      throw new Error("This service command takes no arguments");
    while (options.length) {
      const option = options.shift();
      if (option === "--follow") follow = true;
      else if (option === "--lines") {
        const value = options.shift();
        if (!value || !/^\d+$/.test(value))
          throw new Error("Use mate node logs --lines <number> [--follow]");
        lines = Number(value);
      } else throw new Error("Use mate node logs [--lines <number>] [--follow]");
    }
    const metadata = verifyBundle(directory);
    probeBundle(directory, metadata);
    process.stdout.write(
      await manageNode(command, nodePaths(), directory, metadata.version, undefined, {
        lines,
        follow,
      }),
    );
    return;
  }
  throw new Error(
    "Usage: mate --version; mate node install/start/stop/restart/status/logs [--lines <number>] [--follow]",
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(`Mate: ${error instanceof Error ? error.message : "command failed"}\n`);
  process.exitCode = 1;
});
