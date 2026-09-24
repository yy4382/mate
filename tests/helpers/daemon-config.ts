import {configSchema} from '../../src/config.js';
import {agentDefinition} from '../../src/domain/agents.js';
import {daemonConfigSchema,slackHumanId} from '../../src/daemon/config.js';
import {configFixture} from './config.js';

/** Convert the compact Slack test fixture into the current deployment format. */
export function daemonFixture(dataDir:string,input:unknown=configFixture,runtime:Record<string,unknown>={}){
 const fixture=configSchema.parse(input);
 const principals=Object.fromEntries(fixture.ownerUserIds.map(id=>[id,slackHumanId(fixture.teamId,id)]));
 return daemonConfigSchema.parse({version:2,
  mate:{agents:fixture.agents.map(agentDefinition),ownerUserIds:Object.values(principals),runTimeoutMs:fixture.runTimeoutMs},
  adapters:{slack:{teamId:fixture.teamId,principals,bindings:fixture.agents.map(({id,slackAppId,slackUserId,slackBotId,botTokenEnv,appTokenEnv,channels})=>({agentId:id,slackAppId,slackUserId,slackBotId,botTokenEnv,appTokenEnv,channels}))}},
  runtime:{dataDir,...runtime}});
}
