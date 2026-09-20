import { z } from 'zod';
/** Trusted host adapters register capabilities. Model input cannot install adapters or change context. Adapters own domain authorization and durable effect receipts; registration alone does not provide Broker semantics. Production calls must use ToolRouter.call for common run/work/seat enforcement. */
export interface Capability<C,R> {
  name:string;
  description:string;
  schema:z.ZodType;
  execute(context:C,input:any):Promise<R>;
}
export class ToolEnvironment<C,R> {
  private readonly capabilities=new Map<string,Capability<C,R>>();
  register(capability:Capability<C,R>):void {
    if(!/^[a-zA-Z][a-zA-Z0-9_.]*$/.test(capability.name)||capability.name.startsWith('tools.')||this.capabilities.has(capability.name))throw new Error('Invalid or duplicate capability');
    this.capabilities.set(capability.name,{...capability});
  }
  list(){return [...this.capabilities.values()].map(({name,description})=>({name,description}));}
  describe(name:string){const c=this.get(name);return {name:c.name,description:c.description,inputSchema:z.toJSONSchema(c.schema)};}
  async execute(context:C,name:string,input:unknown):Promise<R>{const c=this.get(name);return c.execute(context,c.schema.parse(input));}
  private get(name:string){const c=this.capabilities.get(name);if(!c)throw new Error('Unknown operation');return c;}
}
