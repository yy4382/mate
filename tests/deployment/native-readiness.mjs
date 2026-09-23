import {existsSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {completeManagedStartup} from './readiness.mjs';

const [gate,mode]=process.argv.slice(2);
if(!gate||!['success','fail'].includes(mode))throw new Error('Expected gate and mode');
let clock=0;
await completeManagedStartup(async progress=>{
  await delay(300);
  clock=60_000;
  progress();
  while(!existsSync(gate))await delay(50);
  if(mode==='fail')throw new Error('Synthetic prerequisite failed');
},process.env,undefined,()=>clock);
await delay(60_000);
