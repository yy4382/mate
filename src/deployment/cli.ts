import { dualServiceDoctor, installDualService, readDualServiceConfig } from "./dual-installer.js";
import { isEntryModule } from "./host.js";

/** The only supported first-release installer operates the control plane and Linux node separately. */
export async function deploymentMain(args = process.argv.slice(2)): Promise<void> {
  const [action, configPath, releasePath] = args;
  if (action === "doctor" && args.length === 2 && configPath) {
    process.stdout.write(
      `${JSON.stringify(dualServiceDoctor(readDualServiceConfig(configPath)), null, 2)}\n`,
    );
    return;
  }
  if (
    (action === "install" || action === "upgrade") &&
    args.length === 3 &&
    configPath &&
    releasePath
  ) {
    process.stdout.write(
      `${JSON.stringify(installDualService(readDualServiceConfig(configPath), releasePath, action === "upgrade"), null, 2)}\n`,
    );
    return;
  }
  throw new Error("Usage: mate-deploy install|upgrade CONFIG RELEASE; mate-deploy doctor CONFIG");
}

export function isDeploymentMainModule(
  argument: string | undefined,
  moduleUrl = import.meta.url,
): boolean {
  return isEntryModule(argument, moduleUrl);
}

if (isDeploymentMainModule(process.argv[1]))
  deploymentMain().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Mate deployment failed"}\n`);
    process.exitCode = 1;
  });
