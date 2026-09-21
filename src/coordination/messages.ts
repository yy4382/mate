import {randomUUID} from 'node:crypto';
import type {Collaboration,Task} from '../collaboration/service.js';
import {encode,type RunToken} from '../storage/store.js';
import {messageKey,type NormalMessage,type Target} from '../conversations/messages.js';
interface Ref{channel:string;ts:string}
interface Intent{id:string;agent_id:string;work_id:string;operation:string;args:string;target:string;state:string;hold_id:string|null;receipt:string|null}
export class MessageTasks{
 constructor(readonly c:Collaboration){}
 private message(actor:string,ref:Ref):NormalMessage{
  this.c.messages.requireReadable(actor);this.c.messages.requireAccess(actor,ref.channel);
  const row=this.c.store.db.prepare('SELECT m.body FROM messages m JOIN message_visibility v ON v.key=m.key WHERE v.agent_id=? AND m.key=? AND m.deleted=0').get(actor,messageKey({team:this.c.config.teamId,...ref})) as {body:string}|undefined;
  if(!row)throw new Error('Message not visible or deleted');return JSON.parse(row.body);
 }
 find(actor:string,ref:Ref):Task|undefined{const m=this.message(actor,ref);this.c.activateDelegations();return this.c.store.db.prepare('SELECT *,0 legacy FROM tasks WHERE message_key=?').get(messageKey(m)) as Task|undefined;}
 private target(actor:string,args:any):Target{if(args.message){const m=this.message(actor,args.message);return{channel:m.channel,thread:m.thread};}const t=this.c.task(args.taskId);this.c.messages.requireAccess(actor,JSON.parse(t.target).channel);return JSON.parse(t.target);}
 submit(run:RunToken,workId:string,id:string,operation:string,args:any,viewToken?:string):unknown{
  const s=this.c.store;return s.atomic(()=>{s.assertRun(run);const target=this.target(run.agentId,args),old=s.db.prepare('SELECT * FROM task_intents WHERE id=?').get(id) as Intent|undefined;
   if(old){if(old.agent_id!==run.agentId||old.operation!==operation||old.args!==encode(args))throw new Error('Task intent identity conflict');return this.describe(run.agentId,id);}
   s.db.prepare('INSERT INTO task_intents VALUES(?,?,?,?,?,?,?,NULL,NULL)').run(id,run.agentId,workId,operation,encode(args),encode(target),'held');
   this.c.messages.persistence.writes.mutable('task_intents',id);
   return this.tryApply(run,id,viewToken,false);
  });
 }
 describe(actor:string,id:string):unknown{const i=this.intent(actor,id);return{intentId:i.id,status:i.state,holdId:i.hold_id,target:JSON.parse(i.target),result:i.receipt?JSON.parse(i.receipt):null,choices:['retry_with_view','discard','continue_once']};}
 private intent(actor:string,id:string):Intent{const i=this.c.store.db.prepare('SELECT * FROM task_intents WHERE id=? AND agent_id=?').get(id,actor) as Intent|undefined;if(!i)throw new Error('Unknown task intent');this.c.messages.persistence.records.mutableTarget('task_intents',id);this.c.messages.requireAccess(actor,JSON.parse(i.target).channel);return i;}
 retry(run:RunToken,id:string,viewToken?:string):unknown{return this.c.store.atomic(()=>this.tryApply(run,id,viewToken,false));}
 continue(run:RunToken,id:string,holdId:string):unknown{return this.c.store.atomic(()=>{const i=this.intent(run.agentId,id);if(i.state!=='held'||i.hold_id!==holdId)throw new Error('Task hold receipt conflict');return this.tryApply(run,id,undefined,true);});}
 discard(run:RunToken,id:string):unknown{this.c.store.assertRun(run);const i=this.intent(run.agentId,id);if(i.state!=='held')throw new Error('Task intent is not held');this.c.store.db.prepare("UPDATE task_intents SET state='discarded' WHERE id=?").run(id);return this.describe(run.agentId,id);}
 private tryApply(run:RunToken,id:string,token:string|undefined,continued:boolean):unknown{
  const c=this.c,s=c.store;s.assertRun(run);const i=this.intent(run.agentId,id);if(i.state!=='held')return this.describe(run.agentId,id);
  const args=JSON.parse(i.args),target=this.target(run.agentId,args);
  if(!continued&&!c.attention.valid(run,target,token)){s.db.prepare('UPDATE task_intents SET hold_id=? WHERE id=?').run(randomUUID(),id);return this.describe(run.agentId,id);}
  let task:Task;
  if(args.message){
   const message=this.message(run.agentId,args.message),key=messageKey(message),existing=this.find(run.agentId,args.message);
   if(existing)task=existing;
   else{
    if(args.expectedVersion!==0)throw new Error('Task version conflict');
    const bound=s.db.prepare('SELECT work_id FROM message_work WHERE message_key=?').get(key) as {work_id:string}|undefined;
    const work=bound?.work_id??i.work_id;c.assertActionWork(run,work);
    const taskId=c.createTask(run.agentId,work,target,message.text.slice(0,500)||'Message task');s.db.prepare('UPDATE tasks SET message_key=? WHERE id=?').run(key,taskId);task=c.task(taskId);
   }
  }else task=c.task(args.taskId);
  c.assertActionWork(run,task.work_id);c.messages.requireAccess(run.agentId,JSON.parse(task.target).channel);
  if(task.version!==args.expectedVersion)throw new Error('Task version conflict');
  const previousVersion=task.version;
  switch(i.operation){
   case 'tasks.claim':c.claim(run.agentId,task.id);break;
   case 'tasks.wait':c.wait(run.agentId,task.id,args.dependencyId);break;
   case 'tasks.update':c.update(run.agentId,task.id,args.status,args.result);break;
   case 'tasks.unclaim':case 'tasks.transfer':{
    if(task.owner!==run.agentId||!['doing','waiting','review'].includes(task.status))throw new Error('Task not owned or terminal');
    const peer=i.operation==='tasks.transfer'?args.peerId:null;if(peer){c.messages.agent(peer);c.messages.requireAccess(peer,target.channel);}
    s.db.prepare("UPDATE tasks SET owner=?,assigned_to=NULL,status=?,waiting_on=NULL,version=version+1 WHERE id=? AND version=?").run(peer,peer?'doing':'todo',task.id,args.expectedVersion);
    s.db.prepare('INSERT INTO task_events(task_id,at,body) VALUES(?,?,?)').run(task.id,Date.now(),encode({action:i.operation,actor:run.agentId,peer}));
    if(peer)c.enqueue(peer,task.work_id,`transfer:${task.id}:${task.version+1}`,{kind:'task_transfer',taskId:task.id,target});break;
   }
   default:throw new Error('Invalid task operation');
  }
  task=c.task(task.id);
  if(task.version!==previousVersion){
  if(task.message_key){
   const source=s.db.prepare('SELECT thread FROM messages WHERE key=?').get(task.message_key) as {thread:string};
   s.db.prepare('INSERT INTO conversation_events(channel,thread,message_key,revision,kind) VALUES(?,?,?,?,?)').run(target.channel,source.thread,task.message_key,`task:${task.version}`,'task');
  }
  const outputId=`task-state:${task.id}:${task.version}`;
  c.send(run.agentId,task.work_id,target,`Mate task ${task.id}: ${task.status}; owner=${task.owner??'unclaimed'}; version=${task.version}; source=${task.message_key ? JSON.parse(task.message_key).slice(1).join('/') : 'legacy unanchored task'}.`,outputId,{run,systemProjection:true});
  s.db.prepare('INSERT INTO task_projections VALUES(?,?,?)').run(outputId,task.id,task.version);
  }
  s.db.prepare("UPDATE task_intents SET state='applied',hold_id=NULL,receipt=? WHERE id=?").run(encode(task),id);return this.describe(run.agentId,id);
 }
 create(run:RunToken,workId:string,target:Target,title:string,viewToken?:string):Task{
  return this.c.store.atomic(()=>{const id=this.c.createTask(run.agentId,workId,target,title),outputId=`task-create:${id}`;this.c.send(run.agentId,workId,target,title,outputId,{run,viewToken});this.c.store.db.prepare("UPDATE tasks SET status='draft',outbox_id=? WHERE id=?").run(outputId,id);return this.c.task(id);});
 }
}
