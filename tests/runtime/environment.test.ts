import {expect,it}from 'vitest';
import {z}from 'zod';
import {ToolEnvironment}from '../../src/runtime/environment.js';
it('trusted adapters are discoverable, receive host context and reject forged args',async()=>{
 const env=new ToolEnvironment<{actor:string},string>();const schema=z.object({value:z.string()}).strict();
 const adapter={name:'custom.inspect',description:'Configured adapter',schema,execute:async(context:{actor:string},input:{value:string})=>`${context.actor}:${input.value}`};
 env.register(adapter);expect(env.list()).toEqual([{name:'custom.inspect',description:'Configured adapter'}]);expect(env.describe('custom.inspect').inputSchema).toHaveProperty('properties');
 expect(await env.execute({actor:'A'},'custom.inspect',{value:'ok'})).toBe('A:ok');
 await expect(env.execute({actor:'A'},'custom.inspect',{value:'ok',actor:'B'})).rejects.toThrow();expect(()=>env.register(adapter)).toThrow('duplicate');
 await expect(env.execute({actor:'A'},'tools.call',{})).rejects.toThrow('Unknown');
});
