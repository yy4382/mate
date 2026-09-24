import { createReleaseManifest } from "./release.js";
import { slackAppManifest } from "../slack/capabilities.js";
import { deploymentDiagnostics } from "./diagnostics.js";
import { resolve } from "node:path";
import { daemonConfigSchema, type DaemonConfig } from "../daemon/config.js";
import { deploymentSpecSchema, type DeploymentSpec } from "./spec.js";
import {
  isEntryModule,
  nodeHostOperations,
  readOperatorText,
  type HostOperations,
} from "./host.js";
import { createLinuxDeploymentPlan } from "./linux-plan.js";
import {
  disableLinuxDeployment,
  finishLinuxUpgrade,
  installLinuxDeployment,
  preflightLinuxDeployment,
  upgradeLinuxDeployment,
} from "./linux-installer.js";

/** Read the deployment spec and its configuration through the host entry, never around it. */
async function readLinuxDeploymentInputs(
  host: HostOperations,
  path: string,
): Promise<{ spec: DeploymentSpec; config: DaemonConfig }> {
  const spec = deploymentSpecSchema.parse(JSON.parse(await readOperatorText(host, resolve(path))));
  const config = daemonConfigSchema.parse(
    JSON.parse(await readOperatorText(host, resolve(spec.configSource))),
  );
  return { spec, config };
}

export async function deploymentMain(args = process.argv.slice(2)): Promise<void> {
  const [command, input] = args,
    host = nodeHostOperations();
  if (command === "release-manifest") {
    if (args.length !== 3 || !input || !args[2])
      throw new Error("Usage: mate-deploy release-manifest RELEASE_DIR COMMIT");
    process.stdout.write(
      `${JSON.stringify(await createReleaseManifest(host, input, args[2]), null, 2)}\n`,
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
    if (host.euid() !== 0) throw new Error("Root required");
    process.stdout.write(
      `${JSON.stringify(await deploymentDiagnostics(host, command), null, 2)}\n`,
    );
    return;
  }
  if (command === "rollback" || command === "finalize") {
    if (args.length !== 1) throw new Error("Upgrade maintenance takes no paths");
    await finishLinuxUpgrade(host, command);
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
    const config = daemonConfigSchema.parse(
      JSON.parse(await readOperatorText(host, resolve(input))),
    );
    await disableLinuxDeployment(host, config);
    process.stdout.write("Mate is disabled; state, homes and checkpoints were retained.\n");
    return;
  }
  const { spec, config } = await readLinuxDeploymentInputs(host, input);
  if (command === "plan") {
    process.stdout.write(
      `${JSON.stringify(await createLinuxDeploymentPlan(spec, config, host), null, 2)}\n`,
    );
    return;
  }
  if (command === "preflight") {
    process.stdout.write(
      `${JSON.stringify(await preflightLinuxDeployment(host, spec, config), null, 2)}\n`,
    );
    return;
  }
  if (command === "upgrade") {
    process.stdout.write(
      `${JSON.stringify(await upgradeLinuxDeployment(host, spec, config), null, 2)}\n`,
    );
    return;
  }
  process.stdout.write(
    `${JSON.stringify(await installLinuxDeployment(host, spec, config), null, 2)}\n`,
  );
}

export function isDeploymentMainModule(
  argument: string | undefined,
  moduleUrl = import.meta.url,
): boolean {
  return isEntryModule(argument, moduleUrl);
}
if (isDeploymentMainModule(process.argv[1]))
  deploymentMain().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Mate deployment failed"}\n`);
    process.exitCode = 1;
  });
