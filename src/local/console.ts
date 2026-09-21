import {z} from 'zod';
import {createInterface} from 'node:readline';
import type {Readable,Writable} from 'node:stream';
import type {LocalAdapter} from './input.js';
import type {Controls} from '../daemon/control.js';
import {conversationTargetSchema} from '../domain/conversations.js';
const base={id:z.string().min(1).max(200),human:z.string().min(1).max(1000)};
const request=z.discriminatedUnion('op',[
  z.object({...base,op:z.literal('send'),eventId:z.string().min(1).max(1000),target:conversationTargetSchema,text:z.string().min(1).max(35000)}).strict(),
  z.object({...base,op:z.literal('read'),target:conversationTargetSchema,before:z.string().regex(/^\d+$/).optional()}).strict(),
  z.object({...base,op:z.literal('rooms')}).strict(),
  z.object({...base,op:z.literal('control'),text:z.string().min(1).max(35000)}).strict()
]);
/** Trusted host JSONL interface. It calls the same application and control services. */
export class LocalConsole {
  constructor(readonly input:LocalAdapter,readonly controls:Controls){}
  execute(value:unknown):{id:string;result:unknown}{
    const r=request.parse(value);
    // Check configured host identities even for owner controls.
    this.input.rooms(r.human);
    switch(r.op){
      case 'send':return{id:r.id,result:this.input.receive(r.human,r.eventId,r.target,r.text)};
      case 'read':return{id:r.id,result:this.input.read(r.human,r.target,r.before)};
      case 'rooms':return{id:r.id,result:this.input.rooms(r.human)};
      case 'control':return{id:r.id,result:this.controls.execute(r.human,r.text)};
    }
  }
  async serve(source:Readable,destination:Writable,signal:AbortSignal):Promise<void>{
    const lines=createInterface({input:source,crlfDelay:Infinity});
    const stop=()=>lines.close();signal.addEventListener('abort',stop,{once:true});
    try{
      if(signal.aborted)return;
      for await(const line of lines){
        if(signal.aborted)break;
        let id:unknown=null,response:unknown;
        try{if(line.length>100000)throw new Error('Local request too large');const parsed=JSON.parse(line);id=typeof parsed?.id==='string'?parsed.id.slice(0,200):null;response=this.execute(parsed);}
        catch(error){response={id,error:error instanceof Error?error.message:'Local request failed'};}
        destination.write(JSON.stringify(response)+'\n');
      }
    }finally{signal.removeEventListener('abort',stop);lines.close();}
  }
}
