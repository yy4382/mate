import {z} from 'zod';
import type {RunToken} from '../storage/store.js';
import type {Broker,EffectiveGrant} from '../policy/broker.js';
import type {Collaboration} from '../collaboration/service.js';
import type {WorkspaceProfile} from './workspaces.js';
import type {ConversationTarget} from '../domain/conversations.js';

const availability=z.enum(['configured','unavailable']);
export const environmentReportSchema=z.object({
  format:z.literal('mate.environment.v1'),
  workId:z.string(),
  snapshotAt:z.number().int(),
  authorization:z.literal('informational_snapshot_rechecked_on_every_action'),
  workspaces:z.object({pathStyle:z.enum(['relative_to_grant','host']),execMountPoint:z.string().nullable(),simultaneouslyMounted:z.boolean(),grants:z.array(z.object({id:z.string(),label:z.string(),kind:z.enum(['private','configured','unmapped']),operations:z.array(z.enum(['read','write','exec'])),expires:z.number().int(),capacityBytes:z.number().int().nullable(),hostRoot:z.string().optional()})),unavailable:z.array(z.object({label:z.string(),kind:z.enum(['private','configured']),reason:z.literal('configured_grant_not_effective')}))}),
  execution:z.object({status:availability,network:z.enum(['none','bridge','host']),image:z.string().nullable(),reason:z.string().optional()}),
  research:z.object({status:availability,mode:z.literal('known_public_https_url_only'),allowedHosts:z.array(z.string()),search:z.literal(false),reason:z.string().optional()}),
  attachmentInput:z.object({status:availability,scope:z.literal('visible_external_message_file'),reason:z.string().optional()}),
  artifactOutput:z.object({adapterStatus:availability,status:availability,scope:z.literal('supported_external_target_only'),reason:z.string().optional()})
}).strict();
export type EnvironmentReport=z.infer<typeof environmentReportSchema>;

export interface EnvironmentDeployment {
  image:string|null;
  network:'none'|'bridge'|'host';
  linuxUser?:boolean;
  researchHosts:readonly string[];
  attachmentConfigured(actor:string):boolean;
  artifactConfigured(actor:string):boolean;
  artifactSupported(actor:string,target:ConversationTarget):boolean;
}

export class EnvironmentCapabilities {
  private byRoot=new Map<string,WorkspaceProfile>();
  constructor(readonly collaboration:Collaboration,readonly broker:Broker,readonly profiles:readonly WorkspaceProfile[],readonly deployment:EnvironmentDeployment){for(const profile of profiles)this.byRoot.set(`${profile.agentId}\0${profile.root}`,profile);}
  read(run:RunToken,workId:string):EnvironmentReport {
    const seat=this.collaboration.seats.active(run.agentId),grants=this.broker.effectiveGrants(run,workId),mapped=grants.map(grant=>this.safeGrant(run.agentId,grant));
    const effectiveRoots=new Set(grants.map(grant=>grant.root)),unavailable=this.profiles.filter(profile=>profile.agentId===run.agentId&&(!seat||profile.kind==='private')&&!effectiveRoots.has(profile.root)).map(({label,kind})=>({label,kind,reason:'configured_grant_not_effective' as const}));
    const canExec=mapped.some(grant=>grant.operations.includes('exec'))&&(!!this.deployment.image||!!this.deployment.linuxUser),researchHosts=seat?[]:[...this.deployment.researchHosts],attachmentConfigured=!seat&&this.deployment.attachmentConfigured(run.agentId),target=JSON.parse(this.collaboration.work(workId).target) as ConversationTarget,artifactAdapter=!seat&&this.deployment.artifactConfigured(run.agentId),artifactSupported=artifactAdapter&&this.deployment.artifactSupported(run.agentId,target);
    return environmentReportSchema.parse({
      format:'mate.environment.v1',workId,snapshotAt:Date.now(),authorization:'informational_snapshot_rechecked_on_every_action',
      workspaces:{pathStyle:this.deployment.linuxUser?'host':'relative_to_grant',execMountPoint:this.deployment.linuxUser?null:'/workspace',simultaneouslyMounted:!!this.deployment.linuxUser,grants:mapped,unavailable},
      execution:{status:canExec?'configured':'unavailable',network:canExec&&(!seat||this.deployment.linuxUser)?this.deployment.network:'none',image:canExec?this.deployment.image:null,...(!canExec?{reason:'No effective exec grant and configured execution backend for this work.'}:{})},
      research:{status:researchHosts.length?'configured':'unavailable',mode:'known_public_https_url_only',allowedHosts:researchHosts,search:false,...(!researchHosts.length?{reason:'No allowed known-URL research host for this context.'}:{})},
      attachmentInput:{status:attachmentConfigured?'configured':'unavailable',scope:'visible_external_message_file',...(!attachmentConfigured?{reason:seat?'Independent review isolates external inputs.':'No attachment input adapter is configured for this Agent.'}:{})},
      artifactOutput:{adapterStatus:artifactAdapter?'configured':'unavailable',status:artifactSupported?'configured':'unavailable',scope:'supported_external_target_only',...(!artifactSupported?{reason:seat?'Independent review isolates external outputs.':!artifactAdapter?'No artifact output adapter is configured for this Agent.':'The current work target does not support artifact output.'}:{})}
    });
  }
  private safeGrant(actor:string,grant:EffectiveGrant){const profile=this.byRoot.get(`${actor}\0${grant.root}`);return{id:grant.id,label:profile?.label??`grant-${grant.id.slice(0,12)}`,kind:profile?.kind??'unmapped',operations:grant.operations,expires:grant.expires,capacityBytes:profile?.capacityBytes??null,...(this.deployment.linuxUser?{hostRoot:grant.root}:{})};}
}
