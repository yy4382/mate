import { migrateConfiguration } from './daemon/migrate.js';
import { readFileSync, existsSync, mkdirSync, cpSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import pino from 'pino';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { daemonConfigSchema } from './daemon/config.js';
import { Daemon } from './daemon/app.js';
import { acquireLock } from './daemon/lock.js';
import { Store, hash } from './storage/store.js';
import { ContainerBackend } from './execution/container.js';
import { executionScope } from './daemon/paths.js';
import { backup } from './daemon/backup.js';

export async function main(args = process.argv.slice(2)): Promise<void> {
  const [command, configPath, destination] = args;
  if (command === 'models') { process.stdout.write(JSON.stringify(builtinModels().getModels(configPath).map(m => ({ provider: m.provider, id: m.id, contextWindow: m.contextWindow })), null, 2) + '\n'); return; }
  if (!['check','start','backup','restore','migrate'].includes(command ?? '') || !configPath) throw new Error('Usage: mate check|start CONFIG; mate backup CONFIG DESTINATION; mate restore CONFIG BACKUP; mate models [PROVIDER]');
  const config = daemonConfigSchema.parse(JSON.parse(readFileSync(resolve(configPath), 'utf8')));
  if(command==='migrate'){
    if(!destination||!args[3])throw new Error('Usage: mate migrate OLD_CONFIG NEW_CONFIG BACKUP [--accept-legacy-identity]');
    if(args[4]&&args[4]!=='--accept-legacy-identity')throw new Error('Unknown migration option');
    const next=daemonConfigSchema.parse(JSON.parse(readFileSync(resolve(destination),'utf8')));
    process.stdout.write(JSON.stringify(await migrateConfiguration(config,next,args[3],args[4]==='--accept-legacy-identity'),null,2)+'\n');return;
  }
  if (command === 'check') {
    const models = builtinModels();
    const report = config.mate.agents.map(a => ({ agent: a.id, modelKnown: !!models.getModel(a.model.provider, a.model.id), missingEnv: [a.botTokenEnv, a.appTokenEnv, a.model.apiKeyEnv].filter(ref => !process.env[ref]) }));
    process.stdout.write(JSON.stringify({ localOnly: true, agents: report, containerConfigured: !!config.runtime.docker }, null, 2) + '\n');
    if (report.some(r => !r.modelKnown || r.missingEnv.length)) process.exitCode = 1; return;
  }
  if (command === 'restore') {
    if (!destination) throw new Error('Backup directory required');
    const manifest = JSON.parse(readFileSync(join(resolve(destination), 'COMPLETE.json'), 'utf8'));
    if (manifest.version !== 1 || manifest.dataDir !== resolve(config.runtime.dataDir)) throw new Error('Restore requires a complete checkpoint and its original data directory');
    if (existsSync(config.runtime.dataDir)) throw new Error('Restore requires absent destination; move the previous data directory aside first');
    mkdirSync(join(config.runtime.dataDir, 'state'), { recursive: true, mode: 0o700 });
    cpSync(join(destination, 'mate.sqlite'), join(config.runtime.dataDir, 'state', 'mate.sqlite'), { errorOnExist: true, force: false });
    cpSync(join(destination, 'agents'), join(config.runtime.dataDir, 'agents'), { recursive: true, errorOnExist: true, force: false });
    process.stdout.write('Checkpoint restored; start performs fenced recovery before scheduling.\n'); return;
  }
  if (command === 'backup') {
    if (!destination) throw new Error('Backup destination required');
    const release = acquireLock(join(config.runtime.dataDir, 'state', 'daemon.lock'));
    const store = new Store(join(config.runtime.dataDir, 'state', 'mate.sqlite'));
    try {
      if (config.runtime.docker) await new ContainerBackend({ ...config.runtime.docker, scope: executionScope(config.runtime.dataDir) }).recover();
      store.recover(); await backup(store, config.runtime.dataDir, resolve(destination));
    } finally { store.close(); release(); }
    process.stdout.write('Consistent database and memory checkpoint created.\n'); return;
  }
  const log = pino({ level: 'info', redact: ['token','apiKey','authorization','*.token','*.apiKey','*.authorization'] });
  const daemon = new Daemon(config, log);
  let closing: Promise<void> | undefined;
  const close = () => { closing ??= daemon.close(); return closing; };
  process.once('SIGINT', () => { void close(); }); process.once('SIGTERM', () => { void close(); });
  try { await daemon.start(); } catch { await close(); throw new Error('Daemon startup failed; check installation identities, credentials and sandbox configuration'); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : 'Mate failed'}\n`); process.exitCode = 1; });
