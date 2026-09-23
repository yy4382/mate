import type {Store} from '../storage/store.js';

interface RecoveryState{oldest?:string;cursor?:string;newest:string}
export interface HistoryPage<T>{messages:readonly T[];next:string|undefined}
export interface PageScanOptions<T=any>{store:Store;key:string;maxPages?:number;current?:()=>boolean;onPage?:(()=>void)|undefined;fetch(cursor:string|undefined):Promise<HistoryPage<T>>;visit(messages:readonly T[]):void|boolean|Promise<void|boolean>}
export interface HistoryRecoveryOptions<T=any>{
 store:Store;agentId:string;cursorKey:string;initialOldest:string|undefined;
 current?:()=>boolean;
 onPage?:(()=>void)|undefined;
 fetch(state:{oldest:string|undefined;cursor:string|undefined}):Promise<HistoryPage<T>>;
 timestamp(message:T):string|undefined;ingest(message:T):void;
}
const integer=(value:string)=>{const[a,z='']=value.split('.');return BigInt(a!)*1000000n+BigInt(z.padEnd(6,'0'));};
export const compareSlackTimestamps=(left:string,right:string):number=>integer(left)<integer(right)?-1:integer(left)>integer(right)?1:0;
const stateKey=(agentId:string,cursorKey:string)=>`slack_history_v1:${agentId}:${cursorKey}`;
function read(store:Store,key:string,oldest?:string):RecoveryState{
 const row=store.db.prepare('SELECT value FROM runtime_meta WHERE key=?').get(key) as {value:string}|undefined;
 if(!row)return{...(oldest?{oldest}:{}),newest:oldest??'0.000000'};
 const value=JSON.parse(row.value) as RecoveryState;
 if(typeof value.newest!=='string'||value.oldest!==undefined&&typeof value.oldest!=='string'||value.cursor!==undefined&&typeof value.cursor!=='string')throw new Error('Invalid durable Slack history recovery state');
 return value;
}
function persist(store:Store,key:string,state:RecoveryState):void{store.db.prepare('INSERT INTO runtime_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(state));}
function invalidCursor(error:unknown):boolean{const value=error as {data?:{error?:string}};return value?.data?.error==='invalid_cursor';}

/** Generic durable traversal used where a complete Slack scan is required. */
export async function scanSlackPages<T>(options:PageScanOptions<T>):Promise<'found'|'exhausted'|'paused'> {
 if(options.maxPages!==undefined&&(!Number.isSafeInteger(options.maxPages)||options.maxPages<1))throw new Error('Invalid Slack scan page budget');
 const row=options.store.db.prepare('SELECT value FROM runtime_meta WHERE key=?').get(options.key) as {value:string}|undefined;
 let cursor:string|undefined;if(row){const value=JSON.parse(row.value) as {cursor?:unknown};if(value.cursor!==undefined&&typeof value.cursor!=='string')throw new Error('Invalid durable Slack page scan state');cursor=value.cursor;}
 const seen=new Set<string>();let invalidResets=0,pages=0;
 while(true){
  try{
   const page=await options.fetch(cursor);
   if(options.current&&!options.current())throw new Error('Slack scan invalidated');
   const found=await options.visit(page.messages),next=page.next||undefined;
   if(options.current&&!options.current())throw new Error('Slack scan invalidated');
   if(found){options.store.db.prepare('DELETE FROM runtime_meta WHERE key=?').run(options.key);options.onPage?.();return'found';}
   if(next&&(next===cursor||seen.has(next))){options.store.db.prepare('DELETE FROM runtime_meta WHERE key=?').run(options.key);throw new Error('Slack page cursor repeated');}
   if(!next){options.store.db.prepare('DELETE FROM runtime_meta WHERE key=?').run(options.key);options.onPage?.();return'exhausted';}
   seen.add(next);cursor=next;persist(options.store,options.key,{cursor,newest:'0.000000'});
   options.onPage?.();
   if(++pages===(options.maxPages??Infinity))return'paused';
  }catch(error){
   if(invalidCursor(error)&&cursor&&invalidResets++===0){cursor=undefined;seen.clear();options.store.db.prepare('DELETE FROM runtime_meta WHERE key=?').run(options.key);continue;}
   throw error;
  }
 }
}

/** Exhausted unknown effects retry later; a partial scan retains its page cursor. */
export function slackScanDue(store:Store,key:string,now:number):boolean{
 const row=store.db.prepare('SELECT value FROM runtime_meta WHERE key=?').get(key) as {value:string}|undefined;
 if(!row)return true;
 const state=JSON.parse(row.value) as {nextAt?:unknown};
 if(typeof state.nextAt!=='number'||!Number.isFinite(state.nextAt))throw new Error('Invalid Slack reconciliation schedule');
 return now>=state.nextAt;
}
export function scheduleSlackScan(store:Store,key:string,nextAt:number):void{
 store.db.prepare('INSERT INTO runtime_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify({nextAt}));
}

/** Durable page cursor: a crash repeats at most one page, while ingest remains idempotent. */
export async function recoverSlackHistory<T>(options:HistoryRecoveryOptions<T>):Promise<boolean>{
 const key=stateKey(options.agentId,options.cursorKey);let state=read(options.store,key,options.initialOldest);const seen=new Set<string>();
 try{
  while(true){
   const page=await options.fetch({oldest:state.oldest,cursor:state.cursor});
   if(options.current&&!options.current())throw new Error('Slack history recovery invalidated');
   for(const message of page.messages){options.ingest(message);const timestamp=options.timestamp(message);if(timestamp&&integer(timestamp)>integer(state.newest))state={...state,newest:timestamp};}
   const next=page.next||undefined;
   if(next&&(next===state.cursor||seen.has(next)))throw new Error('Slack history cursor repeated');
   if(!next){options.store.atomic(()=>{options.store.db.prepare('INSERT INTO slack_cursors VALUES(?,?,?) ON CONFLICT(agent_id,channel) DO UPDATE SET ts=excluded.ts').run(options.agentId,options.cursorKey,state.newest);options.store.db.prepare('DELETE FROM runtime_meta WHERE key=?').run(key);});options.onPage?.();return true;}
   seen.add(next);state={...state,cursor:next};persist(options.store,key,state);options.onPage?.();
  }
 }catch(error){
  if(invalidCursor(error)&&state.cursor){state={...(state.oldest?{oldest:state.oldest}:{}),newest:state.newest};persist(options.store,key,state);}
  return false;
 }
}
