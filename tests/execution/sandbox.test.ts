import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { SandboxBackend } from '../../src/execution/backend.js';
import { ContainerBackend, ControlledBackend } from '../../src/execution/container.js';

const roots: string[] = [];
function temp() { const root = realpathSync(mkdtempSync(`${tmpdir()}/mate-isolation-`)); roots.push(root); return root; }
afterEach(() => roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));
// Requires permission for SRT's local proxy sockets. Explicit opt-in prevents mock results being called real isolation.
it.skipIf(process.env.MATE_SANDBOX_TEST !== '1')('real file sandbox and container isolate files, env, network and background processes', async () => {
  const root = temp(), sibling = temp(); writeFileSync(`${sibling}/secret`, 'synthetic-secret');
  const files = new SandboxBackend(resolve('dist/src/execution/runner.js'));
  const commands = new ContainerBackend({ binary: '/usr/local/bin/docker', image: process.env.MATE_DOCKER_IMAGE!, host: process.env.MATE_DOCKER_HOST!, scope: 'mate-test-isolation' });
  const backend = new ControlledBackend(files, commands);
  const execute = (command: string, signal?: AbortSignal) => backend.execute({ root, operation: { kind: 'exec', cwd: '.', command }, timeoutMs: 10000 }, signal);
  const written = await backend.execute({ root, operation: { kind: 'write', path: 'MEMORY.md', content: 'synthetic memory' }, timeoutMs: 10000 });
  expect(written.code, written.stderr).toBe(0); expect(readFileSync(`${root}/MEMORY.md`, 'utf8')).toBe('synthetic memory');
  expect((await backend.execute({ root, operation: { kind: 'read', path: 'MEMORY.md' }, timeoutMs: 10000 })).stdout).toBe('synthetic memory');
  expect((await execute(`/bin/cat '${sibling}/secret'`)).code).not.toBe(0);
  expect((await execute(`printf bad > '${sibling}/escape'`)).code).not.toBe(0); expect(existsSync(`${sibling}/escape`)).toBe(false);
  process.env.MATE_SYNTHETIC_SECRET = 'do-not-inherit';
  try { expect((await execute('printf "%s" "$MATE_SYNTHETIC_SECRET"')).stdout).toBe(''); } finally { delete process.env.MATE_SYNTHETIC_SECRET; }
  let requests = 0;
  const server = createServer((_req, res) => { requests++; res.end('synthetic-network-secret'); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try {
    const port = (server.address() as { port: number }).port;
    const result = await execute(`wget -T 2 -O - http://127.0.0.1:${port}/`);
    expect(result.stdout).not.toContain('synthetic-network-secret'); expect(requests).toBe(0);
  } finally { await new Promise<void>(r => server.close(() => r())); }
  const abort = new AbortController(); const running = execute('(sleep 2; printf late > late.txt) & sleep 20', abort.signal);
  setTimeout(() => abort.abort(), 300);
  await expect(running).rejects.toThrow('aborted');
  await new Promise(r => setTimeout(r, 2100)); expect(existsSync(`${root}/late.txt`)).toBe(false);
}, 20000);
it.skipIf(process.env.MATE_SANDBOX_TEST !== '1')('container destroys detached sessions after normal exit, abort and timeout', async () => {
  const root = temp();
  const backend = new ContainerBackend({ binary: '/usr/local/bin/docker', image: process.env.MATE_DOCKER_IMAGE!, host: process.env.MATE_DOCKER_HOST!, scope: 'mate-test-detached' });
  for (const mode of ['normal','abort','timeout']) {
    const controller = new AbortController();
    const command = `setsid sh -c 'sleep 2; echo escaped > ${mode}.txt' </dev/null >/dev/null 2>&1 & ${mode === 'normal' ? 'exit 0' : 'sleep 20'}`;
    const running = backend.execute({ root, operation: { kind: 'exec', cwd: '.', command }, timeoutMs: mode === 'timeout' ? 700 : 10000 }, controller.signal);
    if (mode === 'abort') setTimeout(() => controller.abort(), 700);
    if (mode === 'normal') expect((await running).code).toBe(0);
    else await expect(running).rejects.toThrow(/aborted|timed out/);
    await new Promise(r => setTimeout(r, 2100)); expect(existsSync(`${root}/${mode}.txt`)).toBe(false);
  }
}, 30000);
it.skipIf(process.env.MATE_SANDBOX_TEST !== '1')('startup cleanup removes only this daemon scope orphaned containers', async () => {
  const scope = `test-${randomUUID()}`, host = process.env.MATE_DOCKER_HOST!, image = process.env.MATE_DOCKER_IMAGE!;
  const cli = (args: string[]) => promisify(execFile)('/usr/local/bin/docker', ['--host', host, ...args], { timeout: 10000 });
  const containers: string[] = [];
  try {
    for (const label of [scope, `${scope}-other`]) {
      const result = await cli(['run', '--detach', '--pull', 'never', '--network', 'none', '--read-only', '--log-driver', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '32', '--label', `mate.execution=${label}`, image, 'sleep', '30']);
      containers.push(result.stdout.trim());
    }
    await new ContainerBackend({ binary: '/usr/local/bin/docker', image, host, scope }).recover();
    await expect(cli(['inspect', containers[0]!])).rejects.toThrow();
    expect((await cli(['inspect', '--format', '{{.State.Running}}', containers[1]!])).stdout.trim()).toBe('true');
  } finally { for (const id of containers) await cli(['rm', '--force', id]).catch(() => {}); }
}, 30000);

it.skipIf(process.env.MATE_SANDBOX_TEST !== '1')('fixed file helper exits when its daemon IPC owner is killed', async () => {
  const root = temp(); await promisify(execFile)('/usr/bin/mkfifo', [`${root}/blocked`]);
  const script = `import { SandboxBackend } from ${JSON.stringify(new URL('../../dist/src/execution/backend.js', import.meta.url).href)}; await new SandboxBackend().execute({root:${JSON.stringify(root)},operation:{kind:'read',path:'blocked'},timeoutMs:60000});`;
  const parent = spawn(process.execPath, ['--input-type=module','-e',script], { stdio: ['ignore','ignore','ignore'] });
  let helper = 0;
  try {
    await vi.waitFor(async () => { const result = await promisify(execFile)('/usr/bin/pgrep',['-P',String(parent.pid)]); helper = Number(result.stdout.trim().split('\n')[0]); expect(helper).toBeGreaterThan(0); });
    await new Promise(resolve => setTimeout(resolve, 700)); process.kill(helper, 0);
    parent.kill('SIGKILL');
    await vi.waitFor(() => expect(() => process.kill(helper,0)).toThrow(), { timeout: 3000 });
  } finally { parent.kill('SIGKILL'); if (helper) { try { process.kill(-helper,'SIGKILL'); } catch {} } }
}, 10000);

it.skipIf(process.env.MATE_SANDBOX_TEST !== '1')('real sandbox supports large stdin writes and structured organization',async()=>{
 const root=temp(),backend=new SandboxBackend(resolve('dist/src/execution/runner.js'));
 const run=(operation:import('../../src/execution/backend.js').Operation)=>backend.execute({root,operation,timeoutMs:10000});
 const value='资料\n'.repeat(40000);expect((await run({kind:'write',path:'notes/large',content:value})).code).toBe(0);expect(readFileSync(`${root}/notes/large`,'utf8')).toBe(value);
 const result=await run({kind:'search',path:'notes',query:'资料'});expect(result.code,result.stderr).toBe(0);expect(JSON.parse(result.stdout).truncated).toBe(true);
 expect((await run({kind:'move',path:'notes/large',destination:'notes/moved'})).code).toBe(0);
 expect((await run({kind:'remove',path:'notes/moved'})).code).toBe(0);
},30000);

it.skipIf(process.env.MATE_SANDBOX_TEST !== '1')('runner preserves a Unicode scalar split across stdin chunks',async()=>{
 const root=temp(),value=Buffer.from(JSON.stringify({root,operation:{kind:'write',path:'unicode',content:'你'},timeoutMs:10000}));
 const child=spawn(process.execPath,[resolve('dist/src/execution/runner.js')],{stdio:['pipe','pipe','pipe','ipc']});let stderr='';child.stderr!.on('data',b=>stderr+=String(b));
 const done=new Promise<number|null>((r,j)=>{child.once('error',j);child.once('close',r);});
 const split=value.indexOf(Buffer.from('你'))+1;child.stdin!.write(value.subarray(0,split));await new Promise(r=>setTimeout(r,400));child.stdin!.end(value.subarray(split));
 expect(await done,stderr).toBe(0);expect(readFileSync(`${root}/unicode`,'utf8')).toBe('你');
},15000);
