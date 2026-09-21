import { fixtureTarget, externalThread } from '../helpers/canonical-slack.js';
import {afterEach,expect,it,vi}from 'vitest';
import {mkdtempSync,realpathSync,rmSync,readFileSync,writeFileSync}from 'node:fs';
import {tmpdir}from 'node:os';
import {resolve}from 'node:path';
import {spawnSync}from 'node:child_process';
import {Store}from '../../src/storage/store.js';
import {Messages,Output}from '../helpers/canonical-slack.js';
import {Collaboration}from '../../src/collaboration/service.js';
import {Broker}from '../../src/policy/broker.js';
import {ToolRouter}from '../../src/runtime/tools.js';
import {Attachments}from '../../src/daemon/attachments.js';
import {Artifacts}from '../../src/daemon/artifacts.js';
import {WebSlackTransport}from '../fixtures/v16/src/slack/transport.js';
import {configFixture}from '../helpers/config.js';
const cleanup:(()=>void)[]=[];afterEach(()=>{cleanup.splice(0).forEach(fn=>fn());vi.unstubAllGlobals();});
function setup(){
 const root=realpathSync(mkdtempSync(`${tmpdir()}/mate-attachments-`)),s=new Store(':memory:');cleanup.push(()=>{s.close();rmSync(root,{recursive:true,force:true});});s.register('research','v1',[]);
 const m=new Messages(s,configFixture);m.membership('research','CTEST',true);const c=new Collaboration(s,m,new Output(m,{post:async()=>({ts:'200.000001'})}),configFixture);
 const broker=new Broker(s,c,{execute:async request=>{const result=spawnSync(process.execPath,[resolve('dist/src/execution/file-operation.mjs'),root],{input:JSON.stringify(request.operation),encoding:'utf8'});return{code:result.status??1,stdout:result.stdout,stderr:result.stderr,truncated:false};}},[]);new ToolRouter(c,broker);
 const target=fixtureTarget('CTEST','100.000001'),work=c.createWork('attachment',target);c.enqueue('research',work,'one',{});const run=s.beginRun('research')!;s.input(run,{});const grantId=broker.issueGrant('UOWNER','research',work,root,['read','write'],Date.now()+100000);
 s.ingest('AONE','attachment',{team_id:'TTEST',event:{type:'message',channel:'CTEST',ts:'100.000001',text:'source',user:'UOWNER',files:[{id:'FFILE',name:'picture.png',mimetype:'image/png',size:4,url_private:'https://ignored.invalid/'}]}});m.normalize('AONE','attachment');
 const transport=new WebSlackTransport({research:'synthetic-token'}),client=transport.clients.get('research')!;client.files.info=vi.fn(async()=>({ok:true,file:{id:'FFILE',size:4,url_private:'https://files.slack.com/files-pri/TTEST-FFILE/picture.png'}}))as any;
 const files=new Attachments(c,broker,transport.clients),args={message:{messageId:target.threadId},fileId:'FFILE',grantId,path:'artifacts/picture.png'},signal=new AbortController().signal;
 return{root,s,m,c,broker,run,work,target,files,args,signal,client};
}
it('downloads visible binary attachments, freezes/publishes the same bytes and hides payload bulk from model drafts',async()=>{
 const{root,c,broker,run,work,target,files,args,signal}=setup(),bytes=Buffer.from([0,255,1,128]);const fetched=vi.fn(async()=>new Response(bytes));vi.stubGlobal('fetch',fetched);
 await files.save(run,work,'download',args,signal);expect(readFileSync(`${root}/${args.path}`)).toEqual(bytes);expect(fetched.mock.calls).toHaveLength(1);
 const call=(fetched.mock.calls as any)[0];expect(call[1].headers.Authorization).toBe('Bearer synthetic-token');expect(call[1].redirect).toBe('error');
 let snapshot:any;const artifacts=new Artifacts(c,broker,{upload:async(_request,artifact,prepared,beforeShare)=>{snapshot=artifact;prepared('FOUT');if(!beforeShare())throw new Error('deferred');return{fileId:'FOUT'};}},{research:root});
 const draft=await artifacts.publish(run,work,'publish',{grantId:args.grantId,path:args.path,title:'picture',target,format:'binary'},signal)as any;expect(draft.artifact.bytes).toBe(4);expect(draft.artifact.content).toBeUndefined();
 writeFileSync(`${root}/${args.path}`,'later');c.output.gate!.continueOnce(run,draft.draftId,1,draft.holdId);await c.output.send(draft.draftId);expect(Buffer.from(snapshot.content,'base64')).toEqual(bytes);expect(snapshot.filename).toBe('picture.png');
});
it('rejects unrelated files, credential-bearing redirects/hosts and revocation during download',async()=>{
 const{root,m,run,work,files,args,signal,client}=setup();const fetcher=vi.fn(async()=>new Response(Buffer.alloc(4)));vi.stubGlobal('fetch',fetcher);
 await expect(files.save(run,work,'foreign',{...args,fileId:'FOTHER'},signal)).rejects.toThrow('visible');expect(client.files.info).not.toHaveBeenCalled();
 client.files.info=vi.fn(async()=>({ok:true,file:{id:'FFILE',size:4,url_private:'https://files.slack.com.evil.invalid/files-pri/x'}}))as any;
 await expect(files.save(run,work,'host',args,signal)).rejects.toThrow('download URL');expect(fetcher).not.toHaveBeenCalled();
 client.files.info=vi.fn(async()=>({ok:true,file:{id:'FFILE',size:4,url_private:'https://files.slack.com/files-pri/x'}}))as any;
 fetcher.mockImplementation(async()=>{m.membership('research','CTEST',false);return new Response(Buffer.alloc(4));});
 await expect(files.save(run,work,'revoked',args,signal)).rejects.toThrow('access');expect(()=>readFileSync(`${root}/${args.path}`)).toThrow();
});
it('a review seat cannot download discussion files, and oversized/truncated transfers do not write',async()=>{
 const{s,files,args,run,work,signal,client}=setup();s.db.prepare('INSERT INTO review_seats VALUES(?,?,?,?,1)').run('research',JSON.stringify({conversationId:'CTEST'}),'brief','/synthetic');
 await expect(files.save(run,work,'seat',args,signal)).rejects.toThrow('review seat');expect(client.files.info).not.toHaveBeenCalled();s.db.prepare('DELETE FROM review_seats').run();
 vi.stubGlobal('fetch',async()=>new Response(Buffer.alloc(3)));await expect(files.save(run,work,'short',args,signal)).rejects.toThrow('Incomplete');
 vi.stubGlobal('fetch',async()=>new Response(Buffer.alloc(1000001)));await expect(files.save(run,work,'large',args,signal)).rejects.toThrow('exceeds');
});
it('old cached messages gain newly preserved file metadata without reviving deleted messages',()=>{
 const{s,m}=setup();m.record({team:'TTEST',channel:'CTEST',thread:'101.000001',ts:'101.000001',revision:'101.000001',text:'old cache',user:'UOWNER',deleted:false},['research']);
 s.ingest('AONE','enriched',{team_id:'TTEST',event:{type:'message',channel:'CTEST',ts:'101.000001',text:'old cache',user:'UOWNER',files:[{id:'FNEW'}]}});m.normalize('AONE','enriched');expect(m.read('research',{conversationId:'CTEST',threadId:m.mapper.messageId('CTEST','101.000001')})[0]?.attachments?.[0]?.id).toBe('FNEW');
});
