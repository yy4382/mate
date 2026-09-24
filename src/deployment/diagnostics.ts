import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import Database from 'better-sqlite3';
import {daemonConfigSchema,type DaemonConfig} from '../daemon/config.js';
import {restoreProgress} from '../daemon/restore.js';
import {ConfiguredAgents} from '../agents/directory.js';
import {OperationsView,type ActivityItem,type OperationsStatus} from '../operations/view.js';
import {diagnosticLogs,diagnosticStatus,type RecoveryState,type ServiceState} from '../operations/diagnostics.js';
import {managedLayout} from './systemd.js';
import {readLinuxUpgradeJournal} from './linux-installer.js';

export function systemdState():ServiceState{
 const result=spawnSync('/usr/bin/systemctl',['show','--property=ActiveState','--value','mate.service'],{encoding:'utf8',timeout:5000,maxBuffer:4096,env:{PATH:'/usr/bin:/bin',LANG:'C'}});
 const state=result.status===0?result.stdout.trim():'';
 return ['active','inactive','activating','deactivating','failed','reloading'].includes(state)?state as ServiceState:'unknown';
}
export async function readRecoveryState(data:string):Promise<RecoveryState>{
 const result:RecoveryState={restore:null,invalid:false};
 try{result.restore=await restoreProgress(data);}catch{result.invalid=true;}
 const linux=join(data,'control','linux-upgrade.json');if(existsSync(linux))try{readLinuxUpgradeJournal(linux);result.linuxUpgrade={phase:'pending'};}catch{result.invalid=true;}
 return result;
}
/** No Daemon/Slack construction, secret environment loading, Store migration or recovery. */
export async function deploymentDiagnostics(command:'status'|'logs'){
 const recovery=await readRecoveryState(managedLayout.data),service=systemdState();
 let snapshot:ReturnType<typeof readOperationsSnapshot>={status:null,items:[],available:false,more:false};
 try{const config=daemonConfigSchema.parse(JSON.parse(readFileSync(managedLayout.config,'utf8')));if(config.runtime.dataDir===managedLayout.data)snapshot=readOperationsSnapshot(config,command);}catch{/* Never echo configuration parse errors. */}
 const {status,items,available,more}=snapshot;
 return {unit:'mate.service',...diagnosticStatus(status,service,recovery),...(command==='logs'?{logs:{available,moreAvailable:more,...diagnosticLogs(items)}}:{})};
}

/** Read-only snapshot shared with offline callers; errors remain opaque. */
export function readOperationsSnapshot(config:DaemonConfig,command:'status'|'logs'){
 let status:OperationsStatus|null=null,items:ActivityItem[]=[],available=false,more=false;
 let db:Database.Database|undefined;
 try{
  db=new Database(join(config.runtime.dataDir,'state','mate.sqlite'),{readonly:true,fileMustExist:true});db.pragma('query_only = ON');
  const view=new OperationsView({config:config.mate,agents:new ConfiguredAgents(config.mate.agents),store:{db}}),owner=config.mate.ownerUserIds[0];
  if(!owner)throw new Error('Missing owner');
  db.transaction(()=>{status=view.status(owner);if(command==='logs'){const page=view.activity(owner,{sources:['runtime','internal_dm'],limit:100});items=page.items;more=page.cursor!==null;}})();available=true;
 }catch{/* Opaque failure: exception strings can contain paths, configuration or SQL values. */}finally{db?.close();}
 return {status,items,available,more};
}
