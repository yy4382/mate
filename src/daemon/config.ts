import { z } from 'zod';
import { isAbsolute } from 'node:path';
import { configSchema } from '../config.js';
const path = z.string().refine(isAbsolute, 'Absolute path required');
import {agentDefinition,agentDefinitionSchema,budgetSettingsSchema,agentIdSchema,secretReferenceSchema} from '../domain/agents.js';
import type {MateConfig} from '../config.js';

const human = z.string().min(1).max(1000);
const workspaceLabel=z.string().regex(/^[a-z][a-z0-9-]{0,62}$/).refine(value=>value!=='private-workspace'&&!value.startsWith('private-'),'Reserved workspace label');
const slackUser = z.string().regex(/^U[A-Z0-9]+$/);
const bindingSchema = z.object({
  agentId:agentIdSchema, slackAppId:z.string().regex(/^A[A-Z0-9]+$/),
  slackUserId:slackUser, slackBotId:z.string().regex(/^B[A-Z0-9]+$/),
  botTokenEnv:secretReferenceSchema,appTokenEnv:secretReferenceSchema,
  channels:z.record(z.string().regex(/^[CDG][A-Z0-9]+$/),z.enum(['mentions','participate']))
}).strict();
export const localRoomSchema=z.object({id:z.string().min(1).max(1000),agents:z.array(agentIdSchema).min(1),humans:z.array(human).min(1)}).strict();
const modernConfigSchema = z.object({
  version:z.literal(2),
  mate:z.object({agents:z.array(agentDefinitionSchema).min(1),ownerUserIds:z.array(human).min(1),budgets:budgetSettingsSchema}).strict(),
  adapters:z.object({
    slack:z.object({teamId:z.string().regex(/^T[A-Z0-9]+$/),principals:z.record(slackUser,human),bindings:z.array(bindingSchema).min(1)}).strict().optional(),
    local:z.object({humans:z.array(human).min(1),rooms:z.array(localRoomSchema)}).strict().optional()
  }).strict(),
  runtime: z.object({
    dataDir: path,
    docker: z.object({ binary: path, host: z.string().startsWith('unix:///'), image: z.string().regex(/^sha256:[a-f0-9]{64}$/),network:z.enum(['none','bridge']).optional() }).strict().optional(),
    limits:z.object({maxActiveRuns:z.number().int().min(1).max(32),maxBackendOperations:z.number().int().min(1).max(32),workerIdleMs:z.number().int().min(1).max(3600000)}).strict().default({maxActiveRuns:1,maxBackendOperations:1,workerIdleMs:300000}),
    workspaceGrants: z.array(z.object({ agentId: z.string(), root: path, operations: z.array(z.enum(['read','write','exec'])).min(1),label:workspaceLabel.optional() }).strict()).default([]),
    researchHosts: z.array(z.string().regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/)).default([]),
  }).strict()
 }).strict().superRefine((c,ctx)=>{
  const fail=(message:string)=>ctx.addIssue({code:'custom',message});
  const unique=(values:string[],label:string)=>{if(new Set(values).size!==values.length)fail(`Duplicate ${label}`);};
  unique(c.mate.agents.map(a=>a.id),'Agent identity');unique(c.mate.ownerUserIds,'owner');
  const ids=new Set(c.mate.agents.map(a=>a.id));
  for(const grant of c.runtime.workspaceGrants){
    if(!ids.has(grant.agentId))fail('Unknown grant agent');
    if(grant.operations.includes('exec')&&!c.runtime.docker)fail('Execution grants require container configuration');
  }
  const slack=c.adapters.slack;
  if(slack){
    for(const key of ['agentId','slackAppId','slackUserId','slackBotId','botTokenEnv','appTokenEnv'] as const)unique(slack.bindings.map(a=>a[key]),`Slack ${key}`);
    unique(Object.values(slack.principals),'Slack human principal');
    for(const [raw,id] of Object.entries(slack.principals)){
      let parts:unknown;try{parts=JSON.parse(id);}catch{/* Friendly opaque ID. */}
      if(Array.isArray(parts)&&parts.length===4&&parts[0]==='slack'&&parts[1]===slack.teamId&&parts[2]==='user'&&parts[3]!==raw)fail('Human principal aliases another Slack identity');
    }
    for(const b of slack.bindings){
      if(!ids.has(b.agentId))fail('Unknown Slack Agent');
      if(b.slackUserId in slack.principals)fail('Human identity must not be an Agent bot identity');
    }
  }
  const local=c.adapters.local;
  if(local){
    unique(local.humans,'local human');unique(local.rooms.map(r=>r.id),'local room');
    for(const room of local.rooms){
      unique(room.agents,'room Agent');unique(room.humans,'room human');
      if(room.agents.some(id=>!ids.has(id))||room.humans.some(id=>!local.humans.includes(id)))fail('Unknown local room member');
    }
  }
});

/** Only the ingress compatibility parser knows the old flattened deployment shape. */
export const daemonConfigSchema=z.preprocess(value=>{
  if(!value||typeof value!=='object'||'version' in value)return value;
  const input=value as Record<string,unknown>;
  if('adapters' in input)return value;
  if(!input.mate||typeof input.mate!=='object'||!('teamId' in input.mate))return value;
  // Keep unknown top-level fields so strict validation rejects rather than silently discards them.
  const legacy=configSchema.parse(input.mate);
  const principals=Object.fromEntries(legacy.ownerUserIds.map(id=>[id,slackHumanId(legacy.teamId,id)]));
  return {...input,version:2,mate:{agents:legacy.agents.map(agentDefinition),ownerUserIds:Object.values(principals),budgets:legacy.budgets},
    adapters:{slack:{teamId:legacy.teamId,principals,bindings:legacy.agents.map(({id,slackAppId,slackUserId,slackBotId,botTokenEnv,appTokenEnv,channels})=>({agentId:id,slackAppId,slackUserId,slackBotId,botTokenEnv,appTokenEnv,channels}))}}};
},modernConfigSchema);
export function slackHumanId(teamId:string,userId:string):string{return JSON.stringify(['slack',teamId,'user',userId]);}

/** Adapter-only compatibility view. The runtime receives the complete pure team instead. */
export function slackRuntimeConfig(config:DaemonConfig):MateConfig|undefined{
  const adapter=config.adapters.slack;if(!adapter)return undefined;
  return {teamId:adapter.teamId,principalIds:adapter.principals,
    ownerUserIds:Object.keys(adapter.principals).filter(id=>config.mate.ownerUserIds.includes(adapter.principals[id]!)),budgets:config.mate.budgets,
    agents:adapter.bindings.map(({agentId,...binding})=>({...config.mate.agents.find(a=>a.id===agentId)!,...binding}))};
}

/** Persisted observations cannot change authors when an owner grant is removed. */
export function assertConfigurationEvolution(previous:DaemonConfig,next:DaemonConfig):void{
  for(const agent of previous.mate.agents)if(!next.mate.agents.some(a=>a.id===agent.id))throw new Error('Existing Agent identities cannot be removed or rebound');
  const before=previous.adapters.slack,after=next.adapters.slack;
  if(before){
    if(!after||before.teamId!==after.teamId)throw new Error('Workspace identity cannot be removed or rebound');
    for(const [raw,id] of Object.entries(before.principals))if(after.principals[raw]!==id)throw new Error('Human identity mapping cannot be removed or rebound');
    for(const [raw,id] of Object.entries(after.principals))if(!(raw in before.principals)&&id!==slackHumanId(before.teamId,raw))throw new Error('Existing workspace human identity cannot be rebound');
    for(const old of before.bindings){const binding=after.bindings.find(b=>b.agentId===old.agentId);
      if(!binding||(['slackAppId','slackUserId','slackBotId'] as const).some(k=>binding[k]!==old[k]))throw new Error('Existing Agent identities cannot be removed or rebound');
    }
  }
}
export type DaemonConfig = z.infer<typeof daemonConfigSchema>;

/** Config identity is structural. Wire requests use a different, immutable byte hash. */
export function sameConfiguration(left: DaemonConfig, right: DaemonConfig): boolean {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item)]));
    }
    return value;
  };
  return JSON.stringify(normalize(daemonConfigSchema.parse(left))) === JSON.stringify(normalize(daemonConfigSchema.parse(right)));
}
