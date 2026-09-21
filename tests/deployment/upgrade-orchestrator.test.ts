import {createHash} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import {existsSync,lstatSync,mkdtempSync,mkdirSync,readFileSync,realpathSync,renameSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {daemonConfigSchema} from '../../src/daemon/config.js';
import {saveConfiguration,applyOfflineConfigurationMigration,storedConfiguration} from '../../src/daemon/migrate.js';
import {Store} from '../../src/storage/store.js';
import {localApplication} from '../../src/local/application.js';
import {buildBaseline} from '../../src/runtime/prompt.js';
import {operationDocumentation} from '../../src/runtime/tools.js';
import {createReleaseManifest} from '../../src/deployment/release.js';
import {configurationIdentity,createDeploymentTopology,deploymentJournalPath,deploymentMigrationAttempt,readDeploymentJournal,replaceUncommittedDeploymentAttempt,assertDeploymentOperationAllowed} from '../../src/deployment/upgrade.js';
import {readRootUpgrade,rootUpgradePath,runUpgrade,type UpgradeHost,type UpgradePaths} from '../../src/deployment/upgrade-orchestrator.js';
import {upgradeHelperRelease} from '../../src/deployment/upgrade-host.js';
import {configFixture} from '../helpers/config.js';
import type {WorkspaceManifest} from '../../src/deployment/workspaces.js';
const roots:string[]=[],stores:Store[]=[];afterEach(()=>{vi.restoreAllMocks();for(const s of stores.splice(0))s.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const digest=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
async function release(path:string,label:string){mkdirSync(join(path,'dist'),{recursive:true});mkdirSync(join(path,'node_modules'));writeFileSync(join(path,'dist','main.js'),label);writeFileSync(join(path,'package.json'),'{}');writeFileSync(join(path,'pnpm-lock.yaml'),'lockfileVersion: 9\n');const m=await createReleaseManifest(path,'abcdef1',{platform:'linux',arch:'x64',node:'v24.21.0',modulesAbi:'137',packageManager:'pnpm@10.33.0'});writeFileSync(join(path,'RELEASE.json'),JSON.stringify(m));return m;}
async function fixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'mate-root-upgrade-')));roots.push(root);
 const paths:UpgradePaths={data:join(root,'data'),config:join(root,'etc','mate.json'),current:join(root,'opt','current'),controller:join(root,'opt','controller'),releases:join(root,'opt','releases'),stagedRelease:join(root,'opt','staged-release'),stagedConfig:join(root,'etc','staged-config.json'),checkpoints:join(root,'backups'),service:join(root,'mate.service')};
 for(const dir of [join(paths.data,'control'),join(paths.data,'state'),join(paths.data,'agents','research'),join(root,'etc'),paths.releases,paths.checkpoints])mkdirSync(dir,{recursive:true});
 const oldStage=join(root,'old-release'),oldRelease=await release(oldStage,'A'),oldPath=join(paths.releases,oldRelease.releaseId);renameSync(oldStage,oldPath);symlinkSync(oldPath,paths.current);symlinkSync(oldPath,paths.controller);
 const manifestPath=join(root,'workspaces.json'),backing=join(root,'research.ext4'),workspace=join(paths.data,'agents','research'),uid=process.getuid!(),gid=process.getgid!(),manifest:WorkspaceManifest={version:1,mounts:[{kind:'private',agentId:'research',root:workspace,backingFile:backing,capacityBytes:64*1024*1024,ownerUid:uid,ownerGid:gid}]};
 writeFileSync(manifestPath,JSON.stringify(manifest));writeFileSync(backing,'synthetic backing');writeFileSync(join(root,'docker'),'synthetic docker',{mode:0o755});writeFileSync(paths.service,'fixed service');const mountPath=join(root,'research.mount');writeFileSync(mountPath,'fixed mount');
 const old=daemonConfigSchema.parse({mate:configFixture,runtime:{dataDir:paths.data,workspaceManifest:manifestPath,docker:{binary:join(root,'docker'),host:'unix:///var/run/docker.sock',image:`sha256:${'a'.repeat(64)}`}}});old.adapters={};const next=structuredClone(old);next.mate.agents[0]!.role='B';writeFileSync(paths.config,JSON.stringify(old));
 const topology=createDeploymentTopology(old,{manifest,manifestPath,manifestSha256:digest(readFileSync(manifestPath)),service:{unitPath:paths.service,sha256:digest(readFileSync(paths.service)),memoryMaxMiB:384},mountUnits:[{root:workspace,backingFile:backing,backingDevice:lstatSync(backing).dev,backingInode:lstatSync(backing).ino,capacityBytes:64*1024*1024,unitPath:mountPath,sha256:digest(readFileSync(mountPath))}]});
 const s=new Store(join(paths.data,'state','mate.sqlite'));stores.push(s);localApplication(s,old.mate);const base=buildBaseline(old.mate.agents[0]!,operationDocumentation);s.register('research',base.configVersion,base.messages);saveConfiguration(s,old);
 let running=true;const events:string[]=[],host:UpgradeHost={uid,gid,serviceUid:uid,serviceGid:gid,active:()=>running,stop:async()=>{events.push('stop');running=false;},start:async()=>{events.push('start');running=true;},topology:()=>topology,
  checkpoint:async(kind,state)=>{events.push(`checkpoint:${kind}`);const path=state.checkpointStages![kind]!.path,stat=lstatSync(path);return{path,device:stat.dev,inode:stat.ino,manifestDevice:stat.dev,manifestInode:stat.ino,manifestHash:'a'.repeat(64)};},
  migrate:async(state,journal)=>{events.push('migrate');applyOfflineConfigurationMigration(s,state.previousConfig,state.nextConfig,{projectRoot:state.next.releasePath,legacyIdentityAttested:false,auditSource:'test-root-upgrade',deployment:deploymentMigrationAttempt(journal,state.previousConfig,state.nextConfig)});},
  probe:async()=>{events.push('offline-probe');},restore:async state=>{events.push('restore');saveConfiguration(s,state.oldConfig);},finishRestore:async()=>{},
  databaseEvidence:journal=>({marker:!!s.db.prepare('SELECT 1 FROM runtime_meta WHERE key=?').get(`deployment_upgrade_v1:${journal.attempt.id}`),configurationHash:configurationIdentity(storedConfiguration(s)!)}),
  replaceAttempt:journal=>replaceUncommittedDeploymentAttempt(deploymentJournalPath(paths.data),journal,s.db,{uid,gid}),
 };
 const stage=async(label:string)=>{if(existsSync(paths.stagedRelease))rmSync(paths.stagedRelease,{recursive:true});await release(paths.stagedRelease,label);const config=structuredClone(old);config.mate.agents[0]!.role=label;writeFileSync(paths.stagedConfig,JSON.stringify(config));return config;};
 await stage('B');return{root,paths,old,next,s,host,stage,events};
}

it('candidate remains offline, activated start failure is irreversible, and successful activation can finalize',async()=>{
 const f=await fixture();await runUpgrade('candidate',f.host,f.paths);expect(f.events).toEqual(['stop','checkpoint:rollback','migrate','offline-probe']);expect(readRootUpgrade(f.paths.data,f.host.uid)?.step).toBe('checked');
 const journal=readDeploymentJournal(f.paths.data)!;expect(journal.phase).toBe('candidate');expect(storedConfiguration(f.s)).toEqual(f.next);
 const start=vi.spyOn(f.host,'start').mockRejectedValueOnce(new Error('start failed'));await expect(runUpgrade('activate',f.host,f.paths)).rejects.toThrow('start failed');expect(readDeploymentJournal(f.paths.data)?.everActivated).toBe(true);
 await expect(runUpgrade('rollback',f.host,f.paths)).rejects.toThrow('fix-forward only');await runUpgrade('activate',f.host,f.paths);expect(start).toHaveBeenCalledTimes(2);await runUpgrade('finalize',f.host,f.paths);expect(existsSync(deploymentJournalPath(f.paths.data))).toBe(false);expect(existsSync(rootUpgradePath(f.paths.data))).toBe(false);expect(realpathSync(f.paths.controller)).toBe(realpathSync(f.paths.current));
});

it('fixes forward from a damaged activated release through the independent recovery controller',async()=>{
 const f=await fixture();await runUpgrade('candidate',f.host,f.paths);await runUpgrade('activate',f.host,f.paths);writeFileSync(join(realpathSync(f.paths.current),'dist','main.js'),'damaged');await f.stage('D');await runUpgrade('fix-forward',f.host,f.paths);expect(readRootUpgrade(f.paths.data,f.host.uid)?.step).toBe('checked');expect(storedConfiguration(f.s)!.mate.agents[0]!.role).toBe('D');expect(realpathSync(f.paths.controller)).not.toBe(realpathSync(f.paths.current));
});

it('routes every recovery helper through the controller and only candidate work through next',async()=>{
 const f=await fixture();await runUpgrade('candidate',f.host,f.paths);const state=readRootUpgrade(f.paths.data,f.host.uid)!;
 for(const action of ['checkpoint-rollback','checkpoint-candidate','restore','finish-restore'] as const)expect(upgradeHelperRelease(state,action)).toBe(state.controller.releasePath);
 for(const action of ['migrate','probe'] as const)expect(upgradeHelperRelease(state,action)).toBe(state.next.releasePath);
});

it.each(['controller:symlink','controller:rename','controller:directory-sync'])('resumes controller publication after %s',async boundary=>{
 const f=await fixture();await runUpgrade('candidate',f.host,f.paths);await runUpgrade('activate',f.host,f.paths);let interrupted=false;f.host.boundary=name=>{if(name===boundary&&!interrupted){interrupted=true;throw new Error('crash');}};await expect(runUpgrade('finalize',f.host,f.paths)).rejects.toThrow('crash');delete f.host.boundary;await runUpgrade('resume',f.host,f.paths);expect(realpathSync(f.paths.controller)).toBe(realpathSync(f.paths.current));expect(existsSync(rootUpgradePath(f.paths.data))).toBe(false);
});

it('does not publish a damaged activated release as the recovery controller',async()=>{
 const f=await fixture();await runUpgrade('candidate',f.host,f.paths);await runUpgrade('activate',f.host,f.paths);const controller=realpathSync(f.paths.controller);writeFileSync(join(realpathSync(f.paths.current),'dist','main.js'),'damaged');await expect(runUpgrade('finalize',f.host,f.paths)).rejects.toThrow();expect(realpathSync(f.paths.controller)).toBe(controller);expect(readDeploymentJournal(f.paths.data)?.everActivated).toBe(true);
});

it.each(['release:rename','release:directory-sync','database-commit','config:file-sync','config:rename','config:directory-sync','current:symlink','current:rename','current:directory-sync','offline-checks'])('resumes candidate after %s without reapplying migration',async boundary=>{
 const f=await fixture();let stopped=false;f.host.boundary=name=>{if(name===boundary&&!stopped){stopped=true;throw new Error('crash');}};
 await expect(runUpgrade('candidate',f.host,f.paths)).rejects.toThrow('crash');const sessions=()=>f.s.db.prepare('SELECT count(*) n FROM sessions').get() as {n:number};
 const before=sessions().n;await runUpgrade('resume',f.host,f.paths);expect(readRootUpgrade(f.paths.data,f.host.uid)?.step).toBe('checked');expect(storedConfiguration(f.s)).toEqual(f.next);expect(f.events).not.toContain('start');expect(sessions().n).toBe(boundary.startsWith('release:')?before+1:before);
});

it('refuses replacement of a pinned staged configuration during resume',async()=>{
 const f=await fixture();f.host.stop=async()=>{throw new Error('stop interrupted');};await expect(runUpgrade('candidate',f.host,f.paths)).rejects.toThrow('stop interrupted');renameSync(f.paths.stagedConfig,`${f.paths.stagedConfig}.old`);writeFileSync(f.paths.stagedConfig,JSON.stringify(f.next));f.host.stop=async()=>{};f.host.active=()=>false;
 await expect(runUpgrade('resume',f.host,f.paths)).rejects.toThrow('Staged configuration was replaced');expect(storedConfiguration(f.s)).toEqual(f.old);
});

it.each(['restore','rollback-config:rename','rollback-current:rename','cleanup:deployment'])('resumes candidate rollback after %s while keeping start blocked',async boundary=>{
 const f=await fixture();await runUpgrade('candidate',f.host,f.paths);let stopped=false;f.host.boundary=name=>{if(name===boundary&&!stopped){stopped=true;throw new Error('crash');}};
 await expect(runUpgrade('rollback',f.host,f.paths)).rejects.toThrow('crash');await expect(assertDeploymentOperationAllowed('start',{config:f.old,releaseRoot:realpathSync(f.paths.current)},{requiredOwnerUid:f.host.uid,requiredOwnerGid:f.host.gid})).rejects.toThrow();
 await runUpgrade('resume',f.host,f.paths);expect(storedConfiguration(f.s)).toEqual(f.old);expect(JSON.parse(readFileSync(f.paths.config,'utf8'))).toEqual(f.old);expect(existsSync(rootUpgradePath(f.paths.data))).toBe(false);expect(f.events).not.toContain('start');
});

it('permits a failed precommit candidate rollback using the actual old current configuration',async()=>{
 const f=await fixture();f.host.migrate=async()=>{throw new Error('precommit migration failure');};await expect(runUpgrade('candidate',f.host,f.paths)).rejects.toThrow('precommit');
 await runUpgrade('rollback',f.host,f.paths);expect(storedConfiguration(f.s)).toEqual(f.old);expect(existsSync(deploymentJournalPath(f.paths.data))).toBe(false);
});

it('replaces only an uncommitted B→C attempt with B→D while retaining irreversible activation',async()=>{
 const f=await fixture();await runUpgrade('candidate',f.host,f.paths);await runUpgrade('activate',f.host,f.paths);const original=readDeploymentJournal(f.paths.data)!,migrate=f.host.migrate;
 await f.stage('C');f.host.migrate=async()=>{throw new Error('C fails before commit');};await expect(runUpgrade('fix-forward',f.host,f.paths)).rejects.toThrow('before commit');const abandoned=readDeploymentJournal(f.paths.data)!;expect(abandoned.phase).toBe('fix-forward');expect(f.host.databaseEvidence(abandoned).marker).toBe(false);
 await f.stage('D');f.host.migrate=migrate;await runUpgrade('fix-forward',f.host,f.paths);const repaired=readDeploymentJournal(f.paths.data)!;expect(repaired.upgradeId).toBe(original.upgradeId);expect(repaired.attempt.id).not.toBe(abandoned.attempt.id);expect(repaired.attempt.previous).toEqual(original.next);expect(repaired.everActivated).toBe(true);expect(repaired.checkpoints.rollback).toEqual(original.checkpoints.rollback);expect(storedConfiguration(f.s)!.mate.agents[0]!.role).toBe('D');await expect(runUpgrade('rollback',f.host,f.paths)).rejects.toThrow('fix-forward only');
});

it('cannot replace an attempt whose database committed before the root journal advanced',async()=>{
 const f=await fixture();await runUpgrade('candidate',f.host,f.paths);await runUpgrade('activate',f.host,f.paths);await f.stage('C');f.host.boundary=name=>{if(name==='database-commit')throw new Error('crash');};await expect(runUpgrade('fix-forward',f.host,f.paths)).rejects.toThrow('crash');await f.stage('D');await expect(runUpgrade('fix-forward',f.host,f.paths)).rejects.toThrow('committed or unproven');expect(storedConfiguration(f.s)!.mate.agents[0]!.role).toBe('C');
});

it.each(['root-journal:rename','root-journal:directory-sync','service-stop','deployment-journal'])('recovers the initial durable boundary %s before allowing any daemon behavior',async boundary=>{
 const f=await fixture();let interrupted=false;f.host.boundary=name=>{if(name===boundary&&!interrupted){interrupted=true;throw new Error('crash');}};
 await expect(runUpgrade('candidate',f.host,f.paths)).rejects.toThrow('crash');await expect(assertDeploymentOperationAllowed('start',{config:f.old,releaseRoot:realpathSync(f.paths.current)},{requiredOwnerUid:f.host.uid,requiredOwnerGid:f.host.gid})).rejects.toThrow();await runUpgrade('resume',f.host,f.paths);expect(readRootUpgrade(f.paths.data,f.host.uid)?.step).toBe('checked');expect(f.events).not.toContain('start');
});

it('failure before the first journal rename makes no live change and permits a fresh candidate command',async()=>{
 const f=await fixture();let interrupted=false;f.host.boundary=name=>{if(name==='root-journal:file-sync'&&!interrupted){interrupted=true;throw new Error('crash');}};await expect(runUpgrade('candidate',f.host,f.paths)).rejects.toThrow('crash');expect(f.events).toEqual([]);expect(storedConfiguration(f.s)).toEqual(f.old);await runUpgrade('candidate',f.host,f.paths);expect(readRootUpgrade(f.paths.data,f.host.uid)?.step).toBe('checked');
});

it('rejects a substituted staged release even with identical content identity',async()=>{
 const f=await fixture();f.host.boundary=name=>{if(name==='service-stop')throw new Error('crash');};await expect(runUpgrade('candidate',f.host,f.paths)).rejects.toThrow('crash');renameSync(f.paths.stagedRelease,`${f.paths.stagedRelease}.saved`);await release(f.paths.stagedRelease,'B');delete f.host.boundary;await expect(runUpgrade('resume',f.host,f.paths)).rejects.toThrow('Staged release was replaced');
});

it('retains the activated deployment decision if its root journal update crashes before start',async()=>{
 const f=await fixture();await runUpgrade('candidate',f.host,f.paths);let interrupted=false;f.host.boundary=name=>{if(name==='deployment-journal'&&!interrupted){interrupted=true;throw new Error('crash');}};await expect(runUpgrade('activate',f.host,f.paths)).rejects.toThrow('crash');expect(readDeploymentJournal(f.paths.data)?.everActivated).toBe(true);expect(f.events).not.toContain('start');await expect(runUpgrade('rollback',f.host,f.paths)).rejects.toThrow('fix-forward only');await runUpgrade('activate',f.host,f.paths);expect(f.events).toContain('start');
});

it('rejects malformed root journals instead of relying only on their step label',async()=>{
 const f=await fixture();await runUpgrade('candidate',f.host,f.paths);await runUpgrade('activate',f.host,f.paths);writeFileSync(rootUpgradePath(f.paths.data),JSON.stringify({version:1,step:'activated'}));await expect(assertDeploymentOperationAllowed('start',{config:f.next,releaseRoot:realpathSync(f.paths.current)},{requiredOwnerUid:f.host.uid,requiredOwnerGid:f.host.gid})).rejects.toThrow();
});

it('can abandon preparation only when there is no migration marker and all live identities remain old',async()=>{
 const f=await fixture();f.host.checkpoint=async()=>{throw new Error('checkpoint full');};await expect(runUpgrade('candidate',f.host,f.paths)).rejects.toThrow('checkpoint full');await runUpgrade('rollback',f.host,f.paths);expect(storedConfiguration(f.s)).toEqual(f.old);expect(existsSync(rootUpgradePath(f.paths.data))).toBe(false);expect(f.events).not.toContain('restore');
});

it('can fix forward again after committed and published C fails its offline check',async()=>{
 const f=await fixture();await runUpgrade('candidate',f.host,f.paths);await runUpgrade('activate',f.host,f.paths);await f.stage('C');f.host.probe=async()=>{throw new Error('C offline check failed');};await expect(runUpgrade('fix-forward',f.host,f.paths)).rejects.toThrow('offline check failed');const failed=readDeploymentJournal(f.paths.data)!;expect(f.host.databaseEvidence(failed).marker).toBe(true);
 await f.stage('D');f.host.probe=async()=>{};await runUpgrade('fix-forward',f.host,f.paths);const repaired=readDeploymentJournal(f.paths.data)!;expect(repaired.attempt.previous).toEqual(failed.next);expect(repaired.everActivated).toBe(true);expect(storedConfiguration(f.s)!.mate.agents[0]!.role).toBe('D');
});

it('a staged D cannot change the frozen C of an already committed attempt resumed after publication failure',async()=>{
 const f=await fixture();await runUpgrade('candidate',f.host,f.paths);await runUpgrade('activate',f.host,f.paths);await f.stage('C');let interrupted=false;f.host.boundary=name=>{if(name==='database-commit'&&!interrupted){interrupted=true;throw new Error('crash');}};await expect(runUpgrade('fix-forward',f.host,f.paths)).rejects.toThrow('crash');await f.stage('D');await runUpgrade('resume',f.host,f.paths);expect(JSON.parse(readFileSync(f.paths.config,'utf8')).mate.agents[0].role).toBe('C');expect(storedConfiguration(f.s)!.mate.agents[0]!.role).toBe('C');
});
