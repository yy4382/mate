import { bootstrapInstall, requireOrdinaryAccount } from "./install-entry.js";
import {
  assertDedicatedRuntime,
  nativeProbe,
  probeBundle,
  runningBundleDirectory,
  verifyBundle,
} from "./bundle.js";
import { manageNode, nodeServiceCommands } from "./service/commands.js";
import { nodePaths } from "./paths.js";
import { uninstallNode } from "./uninstall.js";
import { updateNode } from "./update.js";
import { bundleRequestSchema } from "./acquire-bundle.js";

function parseUpdateOptions(args: string[]) {
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      !name ||
      !value ||
      !["--version", "--package", "--sha256"].includes(name) ||
      options[name.slice(2)] !== undefined
    )
      throw new Error("Use mate node update --version VERSION [--package FILE --sha256 SHA256]");
    options[name.slice(2)] = value;
  }
  return bundleRequestSchema.parse(options);
}

function parseLogOptions(command: string, args: string[]) {
  let lines = 100;
  let follow = false;
  if (command !== "logs" && args.length) throw new Error("This service command takes no arguments");
  while (args.length) {
    const option = args.shift();
    if (option === "--follow") follow = true;
    else if (option === "--lines") {
      const value = args.shift();
      if (!value || !/^\d+$/.test(value))
        throw new Error("Use mate node logs --lines <number> [--follow]");
      lines = Number(value);
    } else throw new Error("Use mate node logs [--lines <number>] [--follow]");
  }
  return { lines, follow };
}

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
  if (args.length === 2 && args[0] === "node" && args[1] === "uninstall") {
    const metadata = verifyBundle(directory);
    probeBundle(directory, metadata);
    process.stdout.write(await uninstallNode(nodePaths(), directory));
    return;
  }
  if (args[0] === "node" && args[1] === "update") {
    const request = parseUpdateOptions(args.slice(2));
    process.stdout.write(await updateNode(request));
    return;
  }
  if (args[0] === "node" && args[1] && nodeServiceCommands.includes(args[1])) {
    const command = args[1];
    const logs = parseLogOptions(command, args.slice(2));
    const metadata = verifyBundle(directory);
    probeBundle(directory, metadata);
    process.stdout.write(
      await manageNode(command, {
        paths: nodePaths(),
        bundleDirectory: directory,
        version: metadata.version,
        logs,
      }),
    );
    return;
  }
  throw new Error(
    "Usage: mate --version; mate node uninstall; mate node install/start/stop/restart/status/logs; mate node update --version VERSION [--package FILE --sha256 SHA256]",
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(`Mate: ${error instanceof Error ? error.message : "command failed"}\n`);
  process.exitCode = 1;
});
