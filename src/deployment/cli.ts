import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { daemonConfigSchema } from '../daemon/config.js';
import { createDeploymentPlan } from './plan.js';
import { disableDeployment, installDeployment, nodeInstallerHost, preflightDeployment, readDeploymentInputs } from './installer.js';

export async function deploymentMain(args = process.argv.slice(2)): Promise<void> {
  const [command, input] = args;
  if (!input || args[2] || !['plan', 'preflight', 'install', 'disable'].includes(command ?? '')) throw new Error('Usage: mate-deploy plan|preflight|install SPEC; mate-deploy disable CONFIG');
  if (command === 'disable') { const config = daemonConfigSchema.parse(JSON.parse(readFileSync(resolve(input), 'utf8'))); disableDeployment(config); process.stdout.write('Mate is disabled; state, backings, units and checkpoints were retained.\n'); return; }
  const { spec, config } = readDeploymentInputs(input), host = nodeInstallerHost();
  if (command === 'plan') { process.stdout.write(`${JSON.stringify(createDeploymentPlan(spec, config, host), null, 2)}\n`); return; }
  if (command === 'preflight') { process.stdout.write(`${JSON.stringify(preflightDeployment(spec, config, host), null, 2)}\n`); return; }
  process.stdout.write(`${JSON.stringify(await installDeployment(spec, config, host), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) deploymentMain().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : 'Mate deployment failed'}\n`); process.exitCode = 1; });
