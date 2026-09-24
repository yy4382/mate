import {slackControlCommand,slackWireEvents} from './capabilities.js';
import {App} from '@slack/bolt';
import {ManagedSocket} from './socket.js';
import {DurableReceiver} from './receiver.js';
import {SlackProjectionInput,SlackProjectionTransport} from './projections.js';
import {SlackProjectionService} from './projection-service.js';
import {CanonicalSlackNormalizer} from './normalize.js';
import type {CanonicalSlackTransport} from './transport.js';
import {Projections} from '../conversations/projections.js';
import {ProjectionImports} from '../conversations/projection-imports.js';
import {SlackService} from '../slack/service.js';
import {Ingress} from '../daemon/ingress.js';
import type {Controls} from '../daemon/control.js';
import type {AdapterLifecycle} from '../daemon/adapter.js';
import type {Collaboration} from '../collaboration/service.js';
import {requireSecret} from '../config.js';
import type {SystemOperations} from '../policy/system-operations.js';

/** Slack owns sockets, replay, HTTP maintenance and projections, not Agent scheduling. */
export class SlackRuntime implements AdapterLifecycle {
  readonly service:SlackService;
  readonly projections:SlackProjectionService;
  private apps:App[]=[];
  private stopped=false;
  private opening?:Promise<void>;
  private closing?:Promise<void>;
  private cleanup?:Promise<void>;
  private nextReconcile=0;
  private nextMembership=Date.now()+300000;
  constructor(readonly c:Collaboration,readonly transport:CanonicalSlackTransport,controls:Controls,readonly report:(message:string)=>void,system?:SystemOperations){
    const projections=new Projections(c.messages,new Map([['slack',new SlackProjectionTransport(transport)]]));
    const imports=new ProjectionImports(c,projections),input=new SlackProjectionInput(projections,imports,transport);
    this.projections=new SlackProjectionService(projections,imports,input,transport);
    const ingress=new Ingress(c,new CanonicalSlackNormalizer(c.messages,transport.mapper,c.output,input));
    this.service=new SlackService(c,transport,ingress,controls,()=>this.stopped,system);
  }
  recover():void{this.projections.core.recover();}
  start(signal:AbortSignal,progress?:()=>void):Promise<void>{return this.opening??=this.open(signal,progress);}
  private async open(signal:AbortSignal,progress?:()=>void):Promise<void>{
    const abort=()=>{void this.close();};signal.addEventListener('abort',abort,{once:true});
    try{
      signal.throwIfAborted();if(this.stopped)throw new Error('Slack adapter closed');
      for(const agent of this.transport.mapper.config.agents)requireSecret(process.env,agent.appTokenEnv);
      this.service.bootstrapRecovery();
      await this.service.verify();progress?.();if(this.stopped)return;
      for(const agent of this.transport.mapper.config.agents){
        const socket=new ManagedSocket(requireSecret(process.env,agent.appTokenEnv));
        socket.onDisconnect(()=>{if(!this.stopped){this.service.recordTransportGap(agent.id);this.nextMembership=0;}});
        const receiver=new DurableReceiver(this.c.store,agent.slackAppId,this.transport.mapper.config.teamId,socket,()=>this.report('Slack receiver error; uncommitted events are not acknowledged'),()=>this.service.replay());
        const app=new App({token:requireSecret(process.env,agent.botTokenEnv),receiver});
        for(const event of slackWireEvents)app.event(event,async()=>{});app.command(slackControlCommand,async()=>{});
        app.action('mate_system_approve',async()=>{});app.action('mate_system_reject',async()=>{});
        this.apps.push(app);
      }
      await Promise.all(this.apps.map(app=>app.start()));progress?.();if(this.stopped)return;
      // Open every durable socket before discovering membership/history so an
      // event concurrent with catch-up is either received live or found by it.
      await this.service.discoverMembership(true,progress);if(this.stopped)return;
      await this.service.membership(true,progress);if(this.stopped)return;
      if(!await this.service.catchUp(true,progress))throw new Error('Slack history recovery did not complete');if(this.stopped)return;
      if(!await this.projections.catchUp(progress))throw new Error('Slack projection history recovery did not complete');if(this.stopped)return;
    }catch(error){await this.stopResources();throw error;}
    finally{signal.removeEventListener('abort',abort);}
  }
  poll():void{if(!this.stopped){this.service.replay();this.projections.imports.replay();this.service.ingress.bindPeerEchoes();}}
  async flush():Promise<void>{
    if(this.stopped)return;
    await this.projections.core.flush();if(this.stopped)return;
    await this.service.flushAdmin();if(this.stopped)return;
    await this.service.flushApprovals();if(this.stopped)return;
    await this.service.flushResults();if(this.stopped)return;
    if(Date.now()>=this.nextReconcile){this.nextReconcile=Date.now()+60000;await this.service.reconcile();if(this.stopped)return;await this.projections.reconcile();}
    if(!this.stopped&&Date.now()>=this.nextMembership){this.nextMembership=Date.now()+300000;await this.service.discoverMembership(false);if(this.stopped)return;await this.service.membership(false);if(this.stopped)return;await this.service.catchUp();if(this.stopped)return;await this.projections.catchUp();}
  }
  private stopResources():Promise<void>{
    this.stopped=true;this.transport.close();
    return this.cleanup??=Promise.allSettled(this.apps.map(app=>Promise.resolve().then(()=>app.stop()))).then(()=>{});
  }
  close():Promise<void>{return this.closing??=(async()=>{await this.stopResources();await this.opening?.catch(()=>{});})();}
}
