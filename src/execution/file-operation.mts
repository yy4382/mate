// Fixed helper inside the OS sandbox. Requests use stdin, never shell/argv data.
import { constants, openSync, readSync, readFileSync, closeSync, writeFileSync, renameSync, mkdirSync, lstatSync, unlinkSync, existsSync, readdirSync, fsyncSync, rmdirSync, fstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Operation } from './backend.js';
const root = process.argv[2]!;
const privateMode=process.argv[3]!=='022';
process.umask(privateMode?0o077:0o022);
const operation = JSON.parse(readFileSync(0,'utf8')) as Exclude<Operation,{kind:'exec'}>;
function checked(path:string):string {
  if(path.includes('\0'))throw new Error('Invalid path');
  return resolve(root,path);
}
function content(path:string):Buffer {
  const fd=openSync(path,constants.O_RDONLY);
  try {if(!fstatSync(fd).isFile())throw new Error('Regular file required');const buf=Buffer.alloc(1000001),n=readSync(fd,buf,0,buf.length,0);if(n>1000000)throw new Error('File exceeds 1 MB limit');return buf.subarray(0,n);}finally{closeSync(fd);}
}
const hash=(data:Buffer|string)=>createHash('sha256').update(data).digest('hex');
const json=(value:unknown)=>process.stdout.write(JSON.stringify(value));
function save(path:string,value:string|Buffer) {
  if(Buffer.byteLength(value)>1000000)throw new Error('File exceeds 1 MB limit');
  mkdirSync(dirname(path),{recursive:true});const temp=`${path}.${randomUUID()}.tmp`;
  try {
    if(existsSync(path)) {
      const old=content(path),history=checked(`${path}.history`);mkdirSync(history,{recursive:true});
      writeFileSync(`${history}/${Date.now()}-${randomUUID()}`,old,{flag:'wx',mode:0o600});
      for(const oldName of readdirSync(history).sort().slice(0,-5))unlinkSync(checked(`${history}/${oldName}`));
    }
    writeFileSync(temp,value,{flag:'wx',mode:privateMode?0o600:0o644});const fd=openSync(temp,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
    renameSync(temp,path);const dir=openSync(dirname(path),'r');try{fsyncSync(dir);}finally{closeSync(dir);}
    json({sha256:hash(value)});
  }finally{try{unlinkSync(temp);}catch{}}
}
const path=checked(operation.path);
switch(operation.kind){
  case 'read_bytes':{const value=content(path);json({base64:value.subarray(operation.offset,operation.offset+operation.length).toString('base64'),offset:operation.offset,totalBytes:value.length,sha256:hash(value)});break;}
  case 'write_bytes':{const value=Buffer.from(operation.base64,'base64');if(value.toString('base64')!==operation.base64)throw new Error('Invalid base64');save(path,value);break;}
  case 'read':{const value=content(path);if(value.length>65536)throw new Error('File exceeds read limit; use search or exec');process.stdout.write(value);break;}
  case 'write':save(path,operation.content);break;
  case 'edit':{
    const value=content(path);if(hash(value)!==operation.expectedHash)throw new Error('File changed');
    const text=value.toString('utf8'),first=text.indexOf(operation.oldText);
    if(first<0||text.indexOf(operation.oldText,first+operation.oldText.length)>=0)throw new Error('Edit must match exactly once');
    save(path,text.slice(0,first)+operation.newText+text.slice(first+operation.oldText.length));break;
  }
  case 'stat':{const stat=lstatSync(path);json({type:stat.isDirectory()?'directory':stat.isFile()?'file':'other',size:stat.size,sha256:stat.isFile()&&stat.size<=1000000?hash(content(path)):null});break;}
  case 'list':{
    const entries:unknown[]=[];let truncated=false,bytes=0;
    for(const name of readdirSync(path).sort()){const stat=lstatSync(resolve(path,name));const entry={name,type:stat.isSymbolicLink()?'symlink':stat.isDirectory()?'directory':stat.isFile()?'file':'other',size:stat.size};bytes+=Buffer.byteLength(JSON.stringify(entry));if(entries.length>=200||bytes>48000){truncated=true;break;}entries.push(entry);}
    json({entries,truncated});break;
  }
  case 'search':{
    const matches:unknown[]=[];let visited=0,bytes=0,truncated=false;
    function visit(file:string){
      if(++visited>1000){truncated=true;return;}const stat=lstatSync(file);
      if(stat.isSymbolicLink())return;
      if(stat.isDirectory()){for(const name of readdirSync(file).sort()){if(visited>=1000||matches.length>=100||bytes>=45000){truncated=true;break;}visit(resolve(file,name));}return;}
      if(!stat.isFile())return;if(stat.size>1000000){truncated=true;return;}
      const data=content(file);if(data.includes(0))return;
      for(const [index,line]of data.toString('utf8').split('\n').entries())if(line.includes(operation.kind==='search'?operation.query:'')){
        const item={path:file,line:index+1,text:line.slice(0,1000),truncated:line.length>1000};bytes+=Buffer.byteLength(JSON.stringify(item));
        if(matches.length>=100||bytes>=45000){truncated=true;break;}matches.push(item);
      }
    }
    visit(path);json({matches,visited,truncated});break;
  }
  case 'mkdir':mkdirSync(path,{recursive:true});json({created:operation.path});break;
  case 'move':{const destination=checked(operation.destination);if(existsSync(destination))throw new Error('Destination exists');renameSync(path,destination);json({moved:operation.path,destination:operation.destination});break;}
  case 'remove':{
    const stat=lstatSync(path);if(operation.expectedHash&&(!stat.isFile()||hash(content(path))!==operation.expectedHash))throw new Error('File changed');
    // Nonempty directories require explicit child removals (or an authorized exec).
    if(stat.isDirectory())rmdirSync(path);else if(stat.isFile())unlinkSync(path);else throw new Error('Regular file or empty directory required');
    json({removed:operation.path});break;
  }
}
