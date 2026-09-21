import { lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import Database from 'better-sqlite3';
import { within } from '../execution/paths.js';
import type { Store } from '../storage/store.js';
import type {DaemonConfig} from './config.js';
import {configurationHash, copyWorkspace, inventoryRegularFile, publishCheckpoint, type CheckpointManifest} from './checkpoint-format.js';
async function backupDatabase(database:Database.Database,dataDir:string,destination:string,config:DaemonConfig,requireIdle:boolean):Promise<void>{
  if(resolve(dataDir)!==resolve(config.runtime.dataDir))throw new Error('Backup data directory must match configuration');const dataStat=await lstat(dataDir);if(!dataStat.isDirectory()||dataStat.isSymbolicLink())throw new Error('Backup data directory must be a directory, not a symlink');
  const liveDatabasePath=join(dataDir,'state','mate.sqlite');if(await realpath(database.name)!==await realpath(liveDatabasePath))throw new Error('Backup connection must own the configured live database');
  const requested=resolve(destination),parent=await realpath(dirname(requested)),final=join(parent,basename(requested));
  const dataRoot=await realpath(dataDir),externalRoots=await Promise.all(config.runtime.workspaceGrants.map(grant=>realpath(grant.root)));
  if(within(dataRoot,final)||within(final,dataRoot)||externalRoots.some(root=>within(root,final)||within(final,root)))throw new Error('Backup destination must be outside live and granted roots');
  try{const existing=await lstat(final);if(!existing.isDirectory()||existing.isSymbolicLink()||(await readdir(final)).length)throw new Error('Checkpoint destination must be absent or one empty directory');if(await realpath(final)!==final)throw new Error('Checkpoint destination must be canonical');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await mkdir(final,{mode:0o700});}
  if(requireIdle&&(database.prepare("SELECT 1 FROM runs WHERE state='active'").get()||database.prepare("SELECT 1 FROM actions WHERE state='executing'").get()))throw new Error('Backup requires idle workers and executors');
  database.pragma('wal_checkpoint(TRUNCATE)');const liveDatabase=await inventoryRegularFile(liveDatabasePath),wal=`${liveDatabasePath}-wal`;try{if((await lstat(wal)).size)throw new Error('Backup database WAL changed after checkpoint');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  {
   const staging=final;
   const agentsDir=join(staging,'agents');await mkdir(agentsDir,{mode:0o700});
   const agents=[];for(const agentId of config.mate.agents.map(agent=>agent.id).sort())agents.push({agentId,entries:await copyWorkspace(join(dataDir,'agents',agentId),join(agentsDir,agentId))});
   const databasePath=join(staging,'mate.sqlite');await database.backup(databasePath);
   const details=await inventoryRegularFile(databasePath);const databaseEntry:CheckpointManifest['database']={path:'mate.sqlite',...details,sourceSha256:liveDatabase.sha256};
   const manifest:CheckpointManifest={version:2,dataDir:resolve(dataDir),at:new Date().toISOString(),configurationHash:configurationHash(config),containerImage:config.runtime.docker?.image??null,excludedExternalRoots:[...new Set(externalRoots)].sort(),agents,database:databaseEntry};
   await publishCheckpoint(staging,manifest);
  }
}

/** Caller stops scheduling and waits for workers/executors to settle before taking this checkpoint. */
export async function backup(store:Store,dataDir:string,destination:string,config:DaemonConfig):Promise<void>{return backupDatabase(store.db,dataDir,destination,config,true);}

/** Recovery snapshot which never constructs Store and therefore never runs a schema migration. Caller holds the daemon lock and has stopped/recovered the execution scope. */
export async function backupDeploymentSnapshot(dataDir:string,destination:string,config:DaemonConfig):Promise<void>{
 const database=new Database(join(dataDir,'state','mate.sqlite'),{fileMustExist:true});try{database.pragma('busy_timeout = 5000');await backupDatabase(database,dataDir,destination,config,false);}finally{database.close();}
}
