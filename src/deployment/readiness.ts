import {spawnSync} from 'node:child_process';

export interface ReadinessResult { code: number; stderr: string }
export type ReadinessRunner = (binary:string,args:readonly string[],environment:NodeJS.ProcessEnv)=>ReadinessResult;

const nodeRunner:ReadinessRunner=(binary,args,environment)=>{
  const result=spawnSync(binary,[...args],{encoding:'utf8',timeout:5000,maxBuffer:4096,env:environment});
  return {code:result.status??1,stderr:result.stderr??String(result.error??'')};
};

/** Complete the Type=notify start job only after Daemon.start() has finished. */
export function notifyServiceReady(environment:NodeJS.ProcessEnv=process.env,run:ReadinessRunner=nodeRunner):void{
  if(!environment.NOTIFY_SOCKET)return;
  const result=run('/usr/bin/systemd-notify',['--ready'],environment);
  if(result.code!==0)throw new Error('Cannot notify the service manager that Mate is ready');
}

export async function completeManagedStartup(start:(progress:()=>void)=>Promise<void>,environment:NodeJS.ProcessEnv=process.env,run:ReadinessRunner=nodeRunner,now:()=>number=Date.now):Promise<void>{
  if(!environment.NOTIFY_SOCKET)throw new Error('Managed Mate start requires a systemd notify socket');
  let lastExtension=now();
  const progress=()=>{
    if(now()-lastExtension<60_000)return;
    const result=run('/usr/bin/systemd-notify',['EXTEND_TIMEOUT_USEC=900000000'],environment);
    if(result.code!==0)throw new Error('Cannot extend the managed startup deadline');
    lastExtension=now();
  };
  await start(progress);notifyServiceReady(environment,run);
}
