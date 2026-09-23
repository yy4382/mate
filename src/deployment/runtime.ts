import {join} from 'node:path';
import type {DaemonConfig} from '../daemon/config.js';
import {nodeWorkspaceHost,verifyWorkspaceManifest,type VerifiedWorkspaces,type WorkspaceHost} from './workspaces.js';
import type {ExecutionBackend,ExecutionRequest,ExecutionResult} from '../execution/backend.js';

export interface DeploymentEnvironment {platform:NodeJS.Platform;workspaceHost:WorkspaceHost;enforceFinalizedRelease?:boolean}
export function nodeDeploymentEnvironment():DeploymentEnvironment{return{platform:process.platform,workspaceHost:nodeWorkspaceHost()};}

/** Shared startup/offline boundary: Linux container execution never receives an ordinary-directory fallback. */
export function verifyDeploymentWorkspaces(config:DaemonConfig,environment:DeploymentEnvironment=nodeDeploymentEnvironment()):VerifiedWorkspaces|undefined{
 if(environment.platform==='linux'&&config.runtime.docker&&!config.runtime.workspaceManifest)throw new Error('Linux container execution requires a workspace manifest');
 if(environment.platform!=='linux'||!config.runtime.workspaceManifest)return undefined;
 return verifyWorkspaceManifest(config.runtime.workspaceManifest,{dataDir:config.runtime.dataDir,stateDir:join(config.runtime.dataDir,'state'),agentIds:config.mate.agents.map(agent=>agent.id),externalRoots:config.runtime.workspaceGrants.map(grant=>grant.root)},environment.workspaceHost);
}

/** Re-check mount identity immediately before every isolated operation so an unmount cannot expose an underlay directory. */
export class DeploymentBoundaryBackend implements ExecutionBackend{
 constructor(private readonly backend:ExecutionBackend,private readonly config:DaemonConfig,private readonly environment:DeploymentEnvironment,private readonly startup:VerifiedWorkspaces){}
 async execute(request:ExecutionRequest,signal?:AbortSignal):Promise<ExecutionResult>{
  const verified=verifyDeploymentWorkspaces(this.config,this.environment);if(!verified)throw new Error('Verified workspace boundary is unavailable');
  if(verified.boundaryIdentity!==this.startup.boundaryIdentity)throw new Error('Workspace boundary changed since startup; restart Mate before using it');
  const roots=new Set([...verified.roots.values(),...verified.externalRoots]);if(!roots.has(request.root))throw new Error('Execution root is outside the verified workspace manifest');
  return this.backend.execute(request,signal);
 }
}
