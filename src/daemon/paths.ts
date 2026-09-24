import {existsSync,realpathSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';

/** Account for a symlinked parent when checking where an Agent home is provisioned. */
export function pathVariants(path:string):string[]{
 const raw=resolve(path),tail:string[]=[];let current=raw;
 while(!existsSync(current)){const parent=dirname(current);if(parent===current)return[raw];tail.unshift(basename(current));current=parent;}
 const physical=resolve(realpathSync(current),...tail);return raw===physical?[raw]:[raw,physical];
}

/** These are locations for Mate or OS state, not candidates for an Agent's private home. */
export function reservedAgentHomePaths(projectRoot:string,state:string,agentsDir:string):string[]{
 const home=homedir(),paths=[projectRoot,state,agentsDir,'/proc','/sys','/dev','/run','/var/run',
  join(home,'.ssh'),join(home,'.gnupg'),join(home,'.docker'),join(home,'.aws'),join(home,'.kube'),join(home,'.netrc'),join(home,'.npmrc'),join(home,'.pypirc')];
 const credentials=process.env.CREDENTIALS_DIRECTORY;if(credentials?.startsWith('/'))paths.push(credentials);
 return [...new Set(paths.flatMap(pathVariants))];
}
