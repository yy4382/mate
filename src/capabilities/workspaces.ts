import {createHash} from 'node:crypto';
import type {Permission} from '../execution/backend.js';
import {canonicalRoot} from '../execution/paths.js';
import type {Broker} from '../policy/broker.js';
import type {Collaboration} from '../collaboration/service.js';

export interface ConfiguredWorkspace {
  agentId:string;
  root:string;
  operations:Permission[];
  label?:string|undefined;
}

export interface WorkspaceProfile {
  agentId:string;
  root:string;
  label:string;
  kind:'private'|'configured';
  operations:Permission[];
  capacityBytes?:number|undefined;
}

function compatibilityLabel(agentId:string,root:string):string {
  const digest=createHash('sha256').update('mate.workspace-label.v1\0').update(agentId).update('\0').update(root).digest('hex').slice(0,16);
  return `workspace-${digest}`;
}

/** Canonicalize and merge configured roots without changing the serialized deployment policy. */
export function normalizeConfiguredWorkspaces(input:readonly ConfiguredWorkspace[],protectedRoots:readonly string[]):WorkspaceProfile[]{
  const grouped=new Map<string,{agentId:string;root:string;operations:Set<Permission>;labels:Set<string>}>();
  for(const item of input){
    const root=canonicalRoot(item.root,[...protectedRoots]),key=`${item.agentId}\0${root}`;
    const row=grouped.get(key)??{agentId:item.agentId,root,operations:new Set<Permission>(),labels:new Set<string>()};
    for(const operation of item.operations)row.operations.add(operation);
    if(item.label)row.labels.add(item.label);
    grouped.set(key,row);
  }
  const profiles:WorkspaceProfile[]=[];
  for(const row of grouped.values()){
    if(row.labels.size>1)throw new Error('One canonical workspace root cannot have multiple labels');
    const label=[...row.labels][0]??compatibilityLabel(row.agentId,row.root);
    profiles.push({agentId:row.agentId,root:row.root,label,kind:'configured',operations:[...row.operations].sort() as Permission[]});
  }
  const labels=new Set<string>();
  for(const profile of profiles){
    const key=`${profile.agentId}\0${profile.label}`;
    if(labels.has(key))throw new Error('Duplicate workspace label for Agent');
    labels.add(key);
  }
  return profiles.sort((a,b)=>a.agentId.localeCompare(b.agentId)||a.label.localeCompare(b.label));
}

export function workspaceProfiles(privateRoots:Readonly<Record<string,string>>,configured:readonly WorkspaceProfile[],execution:boolean,capacityByRoot:ReadonlyMap<string,number>=new Map()):WorkspaceProfile[]{
  const profiles:WorkspaceProfile[]=[];
  for(const [agentId,raw] of Object.entries(privateRoots)){const root=canonicalRoot(raw,[]);profiles.push({agentId,root,label:'private-workspace',kind:'private',operations:execution?['exec','read','write']:['read','write'],...(capacityByRoot.has(root)?{capacityBytes:capacityByRoot.get(root)!}:{})});}
  profiles.push(...configured.map(profile=>capacityByRoot.has(profile.root)?{...profile,capacityBytes:capacityByRoot.get(profile.root)!}:profile));
  return profiles.sort((a,b)=>a.agentId.localeCompare(b.agentId)||Number(a.kind==='configured')-Number(b.kind==='configured')||a.label.localeCompare(b.label));
}

/** Provisioning is a state transition performed before the model can observe a work. */
export class WorkspaceAccess {
  constructor(readonly collaboration:Collaboration,readonly broker:Broker,readonly profiles:readonly WorkspaceProfile[],private stableLinuxAccess=false){}
  provision(agentId:string,workId:string):void {
    const c=this.collaboration,s=c.store,owner=c.config.ownerUserIds[0];if(!owner)throw new Error('Workspace provisioning requires an owner');
    s.atomic(()=>{
      for(const profile of this.profiles.filter(item=>item.agentId===agentId&&(!c.seats.active(agentId)||item.kind==='private'))){
        const existing=s.db.prepare('SELECT id,operations,revoked,expires FROM grants WHERE agent_id=? AND work_id=? AND root=? ORDER BY rowid DESC LIMIT 1').get(agentId,workId,profile.root) as {id:string;operations:string;revoked:number;expires:number}|undefined;
        if(!existing){this.broker.issueGrant(owner,agentId,workId,profile.root,profile.operations,this.stableLinuxAccess?Number.MAX_SAFE_INTEGER:Date.now()+365*86400000);continue;}
        if(existing.revoked||existing.expires<=Date.now())continue;
        const operations=JSON.parse(existing.operations) as Permission[];
        if(JSON.stringify([...operations].sort())!==JSON.stringify(profile.operations)){
          s.db.prepare('UPDATE grants SET operations=? WHERE id=?').run(JSON.stringify(profile.operations),existing.id);
          s.audit('workspace_grant_sync',{grantId:existing.id,agentId,workId,operations:profile.operations});
        }
      }
    });
  }
}
