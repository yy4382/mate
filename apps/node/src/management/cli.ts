import { bootstrapInstall, requireOrdinaryAccount } from "./install-entry.js";
import {
  assertDedicatedRuntime,
  nativeProbe,
  probeBundle,
  runningBundleDirectory,
  verifyBundle,
} from "./bundle.js";

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
  throw new Error("Usage: mate --version. Node service commands are not installed by bootstrap.");
}

void main().catch((error: unknown) => {
  process.stderr.write(`Mate: ${error instanceof Error ? error.message : "command failed"}\n`);
  process.exitCode = 1;
});
