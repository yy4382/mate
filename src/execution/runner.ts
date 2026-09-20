import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkedPath } from './paths.js';
import { operationSchema, type ExecutionRequest } from './backend.js';

// The daemon owns an IPC lifeline even though file requests arrive on stdin.
// A daemon crash must terminate fixed file helpers as well as model workers.
const ownerGone = () => { try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(125); } };
process.on('disconnect', ownerGone);

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
try {
  process.stdin.setEncoding('utf8');
  let input = ''; for await (const chunk of process.stdin) { input += String(chunk); if (input.length > 13000000) throw new Error('Request too large'); }
  const request = JSON.parse(input) as ExecutionRequest;
  const op = operationSchema.parse(request.operation), root = realpathSync(request.root);
  if (op.kind === 'exec') throw new Error('Shell execution requires container isolation');
  if (root !== request.root) throw new Error('Execution root changed');
  const fileHelper = fileURLToPath(new URL('./file-operation.mjs', import.meta.url));
  const cwd = root;
  checkedPath(root, op.path);
  if(op.kind === 'move') checkedPath(root,op.destination);
  if (!SandboxManager.isSupportedPlatform()) throw new Error('Unsupported sandbox platform');
  const dependencies = await SandboxManager.checkDependenciesAsync();
  if (dependencies.errors.length) throw new Error(dependencies.errors.join('; '));
  await SandboxManager.initialize({
    network: { allowedDomains: [], deniedDomains: [], allowLocalBinding: false, allowAllUnixSockets: false },
    filesystem: { denyRead: ['/'], allowRead: [root, '/bin', '/usr/bin', '/usr/lib', '/System', '/private/var/select/sh', realpathSync(process.execPath), fileHelper],
      allowWrite: [root], denyWrite: [] },
  }, undefined, false);
  const command = `${quote(process.execPath)} ${quote(fileHelper)} ${quote(root)}`;
  const wrapped = await SandboxManager.wrapWithSandboxArgv(command, '/bin/sh', undefined, undefined, cwd);
  if (realpathSync(request.root) !== root) throw new Error('Execution root changed');
  if (!SandboxManager.isSandboxingEnabled()) throw new Error('Sandbox is not enabled');
  const [binary, ...args] = wrapped.argv; if (!binary) throw new Error('Missing sandbox executable');
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(binary, args, { cwd, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', ...wrapped.env }, stdio: ['pipe', 'inherit', 'inherit'] });
    child.stdin.on('error',()=>{}); child.stdin.end(JSON.stringify(op));
    child.once('error', reject); child.once('close', code => resolve(code ?? 1));
  });
  await SandboxManager.reset(); process.exitCode = code;
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : 'Sandbox failure');
  await SandboxManager.reset().catch(() => {}); process.exitCode = 125;
}

finally {
  process.off('disconnect', ownerGone);
  if (process.connected) process.disconnect();
}
