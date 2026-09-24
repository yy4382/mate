import { createReleaseManifest } from "./release.js";
import { slackAppManifest } from "../slack/capabilities.js";
import { deploymentDiagnostics } from "./diagnostics.js";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { daemonConfigSchema } from "../daemon/config.js";
import { nodeLinuxInstallerHost, readLinuxDeploymentInputs } from "./linux-host.js";
import { createLinuxDeploymentPlan } from "./linux-plan.js";
import {
  disableLinuxDeployment,
  finishLinuxUpgrade,
  installLinuxDeployment,
  preflightLinuxDeployment,
  upgradeLinuxDeployment,
} from "./linux-installer.js";

export async function deploymentMain(args = process.argv.slice(2)): Promise<void> {
  const [command, input] = args;
  if (command === "release-manifest") {
    if (args.length !== 3 || !input || !args[2])
      throw new Error("Usage: mate-deploy release-manifest RELEASE_DIR COMMIT");
    process.stdout.write(
      `${JSON.stringify(await createReleaseManifest(input, args[2]), null, 2)}\n`,
    );
    return;
  }
  if (command === "slack-manifest") {
    if (args.length !== 2 || !input) throw new Error("Usage: mate-deploy slack-manifest AGENT_ID");
    process.stdout.write(`${JSON.stringify(slackAppManifest(input), null, 2)}\n`);
    return;
  }
  if (command === "status" || command === "logs") {
    if (args.length !== 1) throw new Error("Read-only commands take no arguments");
    if (process.getuid?.() !== 0) throw new Error("Root required");
    process.stdout.write(`${JSON.stringify(await deploymentDiagnostics(command), null, 2)}\n`);
    return;
  }
  if (command === "rollback" || command === "finalize") {
    if (args.length !== 1) throw new Error("Upgrade maintenance takes no paths");
    await finishLinuxUpgrade(command);
    return;
  }
  if (
    !input ||
    args[2] ||
    !["plan", "preflight", "install", "upgrade", "disable"].includes(command ?? "")
  )
    throw new Error(
      "Usage: mate-deploy plan|preflight|install|upgrade SPEC; mate-deploy rollback|finalize; mate-deploy disable CONFIG",
    );
  if (command === "disable") {
    const config = daemonConfigSchema.parse(JSON.parse(readFileSync(resolve(input), "utf8")));
    disableLinuxDeployment(config);
    process.stdout.write("Mate is disabled; state, homes and checkpoints were retained.\n");
    return;
  }
  const { spec, config } = readLinuxDeploymentInputs(input),
    host = nodeLinuxInstallerHost();
  if (command === "install" && JSON.parse(readFileSync(spec.configSource, "utf8"))?.mate?.budgets)
    throw new Error("New installs must use runTimeoutMs; model quotas are unsupported");
  if (command === "plan") {
    process.stdout.write(
      `${JSON.stringify(createLinuxDeploymentPlan(spec, config, host), null, 2)}\n`,
    );
    return;
  }
  if (command === "preflight") {
    process.stdout.write(
      `${JSON.stringify(preflightLinuxDeployment(spec, config, host), null, 2)}\n`,
    );
    return;
  }
  if (command === "upgrade") {
    process.stdout.write(
      `${JSON.stringify(await upgradeLinuxDeployment(spec, config, host), null, 2)}\n`,
    );
    return;
  }
  process.stdout.write(
    `${JSON.stringify(await installLinuxDeployment(spec, config, host), null, 2)}\n`,
  );
}

export function isDeploymentMainModule(
  argument: string | undefined,
  moduleUrl = import.meta.url,
): boolean {
  return !!argument && moduleUrl === pathToFileURL(realpathSync(resolve(argument))).href;
}
if (isDeploymentMainModule(process.argv[1]))
  deploymentMain().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Mate deployment failed"}\n`);
    process.exitCode = 1;
  });
