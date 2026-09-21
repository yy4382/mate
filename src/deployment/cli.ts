import {createReleaseManifest} from './release.js';
import {slackAppManifest} from '../slack/capabilities.js';
import {deploymentDiagnostics} from './diagnostics.js';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {runUpgrade,type UpgradeCommand} from './upgrade-orchestrator.js';
import {nodeUpgradeHost} from './upgrade-host.js';
import { daemonConfigSchema } from '../daemon/config.js';
import { createDeploymentPlan } from './plan.js';
import { disableDeployment, installDeployment, nodeInstallerHost, preflightDeployment, readDeploymentInputs } from './installer.js';

export async function deploymentMain(args = process.argv.slice(2)): Promise<void> {
  const [command, input] = args;
  if(command==='release-manifest'){if(args.length!==3||!input||!args[2])throw new Error('Usage: mate-deploy release-manifest RELEASE_DIR COMMIT');process.stdout.write(`${JSON.stringify(await createReleaseManifest(input,args[2]),null,2)}\n`);return;}
  if(command==='slack-manifest'){if(args.length!==2||!input)throw new Error('Usage: mate-deploy slack-manifest AGENT_ID');process.stdout.write(`${JSON.stringify(slackAppManifest(input),null,2)}\n`);return;}
  if(command==='status'||command==='logs'){if(args.length!==1)throw new Error('Read-only commands take no arguments');if(process.getuid?.()!==0)throw new Error('Root required');process.stdout.write(`${JSON.stringify(await deploymentDiagnostics(command),null,2)}\n`);return;}
  if(['candidate','resume','rollback','activate','finalize','fix-forward'].includes(command??'')){if(input)throw new Error('Upgrade commands take no paths; use fixed root-owned staged inputs');await runUpgrade(command as UpgradeCommand,nodeUpgradeHost());return;}
  if (!input || args[2] || !['plan', 'preflight', 'install', 'disable'].includes(command ?? '')) throw new Error('Usage: mate-deploy plan|preflight|install SPEC; mate-deploy disable CONFIG');
  if (command === 'disable') { const config = daemonConfigSchema.parse(JSON.parse(readFileSync(resolve(input), 'utf8'))); disableDeployment(config); process.stdout.write('Mate is disabled; state, backings, units and checkpoints were retained.\n'); return; }
  const { spec, config } = readDeploymentInputs(input), host = nodeInstallerHost();
  if (command === 'plan') { process.stdout.write(`${JSON.stringify(createDeploymentPlan(spec, config, host), null, 2)}\n`); return; }
  if (command === 'preflight') { process.stdout.write(`${JSON.stringify(preflightDeployment(spec, config, host), null, 2)}\n`); return; }
  process.stdout.write(`${JSON.stringify(await installDeployment(spec, config, host), null, 2)}\n`);
}

export function isDeploymentMainModule(argument:string|undefined,moduleUrl=import.meta.url):boolean{return !!argument&&moduleUrl===pathToFileURL(realpathSync(resolve(argument))).href;}
if (isDeploymentMainModule(process.argv[1])) deploymentMain().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : 'Mate deployment failed'}\n`); process.exitCode = 1; });
