import { lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { within } from '../execution/paths.js';
import type { Store } from '../storage/store.js';
import type {DaemonConfig} from './config.js';
import {configurationHash, copyWorkspace, inventoryRegularFile, publishCheckpoint, type CheckpointManifest} from './checkpoint-format.js';
/** Caller stops scheduling and waits for workers/executors to settle before taking this checkpoint. */
export async function backup(store: Store, dataDir: string, destination: string, config:DaemonConfig): Promise<void> {
  if(resolve(dataDir)!==resolve(config.runtime.dataDir))throw new Error('Backup data directory must match configuration');const dataStat=await lstat(dataDir);if(!dataStat.isDirectory()||dataStat.isSymbolicLink())throw new Error('Backup data directory must be a directory, not a symlink');
  const liveDatabasePath=join(dataDir,'state','mate.sqlite');if(await realpath(store.db.name)!==await realpath(liveDatabasePath))throw new Error('Backup Store must own the configured live database');
  const requested=resolve(destination),parent=await realpath(dirname(requested)),final=join(parent,basename(requested));
  const dataRoot=await realpath(dataDir),externalRoots=await Promise.all(config.runtime.workspaceGrants.map(grant=>realpath(grant.root)));
  if(within(dataRoot,final)||within(final,dataRoot)||externalRoots.some(root=>within(root,final)||within(final,root)))throw new Error('Backup destination must be outside live and granted roots');
  try{const existing=await lstat(final);if(!existing.isDirectory()||existing.isSymbolicLink()||(await readdir(final)).length)throw new Error('Checkpoint destination must be absent or one empty directory');if(await realpath(final)!==final)throw new Error('Checkpoint destination must be canonical');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await mkdir(final,{mode:0o700});}
  if (store.db.prepare("SELECT 1 FROM runs WHERE state='active'").get() || store.db.prepare("SELECT 1 FROM actions WHERE state='executing'").get()) throw new Error('Backup requires idle workers and executors');
  store.db.pragma('wal_checkpoint(TRUNCATE)');const liveDatabase=await inventoryRegularFile(liveDatabasePath),wal=`${liveDatabasePath}-wal`;try{if((await lstat(wal)).size)throw new Error('Backup database WAL changed after checkpoint');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  {
   const staging=final;
   const agentsDir=join(staging,'agents');await mkdir(agentsDir,{mode:0o700});
   const agents=[];for(const agentId of config.mate.agents.map(agent=>agent.id).sort())agents.push({agentId,entries:await copyWorkspace(join(dataDir,'agents',agentId),join(agentsDir,agentId))});
   const databasePath=join(staging,'mate.sqlite');await store.backup(databasePath);
   const details=await inventoryRegularFile(databasePath);const database:CheckpointManifest['database']={path:'mate.sqlite',...details,sourceSha256:liveDatabase.sha256};
   const manifest:CheckpointManifest={version:2,dataDir:resolve(dataDir),at:new Date().toISOString(),configurationHash:configurationHash(config),containerImage:config.runtime.docker?.image??null,excludedExternalRoots:[...new Set(externalRoots)].sort(),agents,database};
   await publishCheckpoint(staging,manifest);
  }
}
