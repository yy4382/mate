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
  workspaces:z.object({pathStyle:z.literal('relative_to_grant'),execMountPoint:z.literal('/workspace'),simultaneouslyMounted:z.literal(false),grants:z.array(z.object({id:z.string(),label:z.string(),kind:z.enum(['private','configured','unmapped']),operations:z.array(z.enum(['read','write','exec'])),expires:z.number().int()})),unavailable:z.array(z.object({label:z.string(),kind:z.enum(['private','configured']),reason:z.literal('configured_grant_not_effective')}))}),
  execution:z.object({status:availability,network:z.enum(['none','bridge']),image:z.string().nullable(),reason:z.string().optional()}),
  research:z.object({status:availability,mode:z.literal('known_public_https_url_only'),allowedHosts:z.array(z.string()),search:z.literal(false),reason:z.string().optional()}),
  attachmentInput:z.object({status:availability,scope:z.literal('visible_external_message_file'),reason:z.string().optional()}),
  artifactOutput:z.object({status:availability,scope:z.literal('supported_external_target_only'),reason:z.string().optional()})
}).strict();
export type EnvironmentReport=z.infer<typeof environmentReportSchema>;

export interface EnvironmentDeployment {
  image:string|null;
  network:'none'|'bridge';
  researchHosts:readonly string[];
  attachmentConfigured(actor:string):boolean;
  artifactSupported(actor:string,target:ConversationTarget):boolean;
}

export class EnvironmentCapabilities {
  private byRoot=new Map<string,WorkspaceProfile>();
  constructor(readonly collaboration:Collaboration,readonly broker:Broker,readonly profiles:readonly WorkspaceProfile[],readonly deployment:EnvironmentDeployment){for(const profile of profiles)this.byRoot.set(`${profile.agentId}\0${profile.root}`,profile);}
  read(run:RunToken,workId:string):EnvironmentReport {
    const seat=this.collaboration.seats.active(run.agentId),grants=this.broker.effectiveGrants(run,workId),mapped=grants.map(grant=>this.safeGrant(run.agentId,grant));
    const effectiveRoots=new Set(grants.map(grant=>grant.root)),unavailable=this.profiles.filter(profile=>profile.agentId===run.agentId&&(!seat||profile.kind==='private')&&!effectiveRoots.has(profile.root)).map(({label,kind})=>({label,kind,reason:'configured_grant_not_effective' as const}));
    const canExec=mapped.some(grant=>grant.operations.includes('exec'))&&!!this.deployment.image,researchHosts=seat?[]:[...this.deployment.researchHosts],attachmentConfigured=!seat&&this.deployment.attachmentConfigured(run.agentId),target=JSON.parse(this.collaboration.work(workId).target) as ConversationTarget,artifactConfigured=!seat&&this.deployment.artifactSupported(run.agentId,target);
    return environmentReportSchema.parse({
      format:'mate.environment.v1',workId,snapshotAt:Date.now(),authorization:'informational_snapshot_rechecked_on_every_action',
      workspaces:{pathStyle:'relative_to_grant',execMountPoint:'/workspace',simultaneouslyMounted:false,grants:mapped,unavailable},
      execution:{status:canExec?'configured':'unavailable',network:canExec&&!seat?this.deployment.network:'none',image:canExec?this.deployment.image:null,...(!canExec?{reason:'No effective exec grant and configured container for this work.'}:{})},
      research:{status:researchHosts.length?'configured':'unavailable',mode:'known_public_https_url_only',allowedHosts:researchHosts,search:false,...(!researchHosts.length?{reason:'No allowed known-URL research host for this context.'}:{})},
      attachmentInput:{status:attachmentConfigured?'configured':'unavailable',scope:'visible_external_message_file',...(!attachmentConfigured?{reason:seat?'Independent review isolates external inputs.':'No attachment input adapter is configured for this Agent.'}:{})},
      artifactOutput:{status:artifactConfigured?'configured':'unavailable',scope:'supported_external_target_only',...(!artifactConfigured?{reason:seat?'Independent review isolates external outputs.':'No artifact output adapter is configured for this Agent.'}:{})}
    });
  }
  private safeGrant(actor:string,grant:EffectiveGrant){const profile=this.byRoot.get(`${actor}\0${grant.root}`);return{id:grant.id,label:profile?.label??`grant-${grant.id.slice(0,12)}`,kind:profile?.kind??'unmapped',operations:grant.operations,expires:grant.expires};}
}
