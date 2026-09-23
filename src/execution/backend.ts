import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
export const operationSchema = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('read_bytes'),path:z.string().max(4096),offset:z.number().int().min(0).max(1000000),length:z.number().int().min(1).max(32768)}).strict(),
  z.object({kind:z.literal('write_bytes'),path:z.string().max(4096),base64:z.string().max(1333336).refine(value=>Buffer.from(value,'base64').toString('base64')===value,'Canonical base64 required')}).strict(),
  z.object({ kind: z.literal('read'), path: z.string().max(4096) }).strict(),
  z.object({ kind: z.literal('write'), path: z.string().max(4096), content: z.string().max(1000000) }).strict(),
  z.object({ kind: z.literal('list'), path: z.string().max(4096) }).strict(),
  z.object({ kind: z.literal('stat'), path: z.string().max(4096) }).strict(),
  z.object({ kind: z.literal('search'), path: z.string().max(4096), query: z.string().min(1).max(1000) }).strict(),
  z.object({ kind: z.literal('mkdir'), path: z.string().min(1).max(4096) }).strict(),
  z.object({ kind: z.literal('move'), path: z.string().min(1).max(4096), destination: z.string().min(1).max(4096) }).strict(),
  z.object({ kind: z.literal('remove'), path: z.string().min(1).max(4096), expectedHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict(),
  z.object({ kind: z.literal('edit'), path: z.string().min(1).max(4096), expectedHash: z.string().regex(/^[a-f0-9]{64}$/), oldText: z.string().min(1).max(1000000), newText: z.string().max(1000000) }).strict(),
  z.object({ kind: z.literal('exec'), command: z.string().min(1).max(16000), cwd: z.string().max(4096) }).strict(),
]);
export type Permission = 'read' | 'write' | 'exec';
export function permissionFor(op: Operation): Permission { return ['read','read_bytes','list','stat','search'].includes(op.kind) ? 'read' : op.kind === 'exec' ? 'exec' : 'write'; }
export type Operation = z.infer<typeof operationSchema>;
export interface ExecutionRequest { root: string; operation: Operation; timeoutMs: number;network?:'none';agentId?:string }
export interface ExecutionResult { code: number; stdout: string; stderr: string; truncated: boolean }
export interface ExecutionBackend { execute(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult> }
/** Each invocation has its own SRT singleton and process group. No host-shell fallback. */
export class SandboxBackend implements ExecutionBackend {
  constructor(private helper = fileURLToPath(new URL('./runner.js', import.meta.url))) {}
  execute(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult> {
    operationSchema.parse(request.operation); z.number().int().min(1).max(300000).parse(request.timeoutMs);
    if (request.operation.kind === 'exec') return Promise.reject(new Error('Arbitrary shell requires the container backend; SRT process groups are insufficient'));
    if (signal?.aborted) return Promise.reject(new Error('Execution aborted'));
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [this.helper], { detached: true,
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
      let stdout = '', stderr = '', truncated = false, stopped = false;
      const limit = 65536;
      const collect = (value: string, chunk: string): string => { const combined=Buffer.from(value+chunk);if(combined.length>limit)truncated=true;return combined.subarray(0,limit).toString('utf8'); };
      child.stdout!.setEncoding('utf8');child.stderr!.setEncoding('utf8');
      child.stdout!.on('data', (b: string) => { stdout = collect(stdout, b); });
      child.stderr!.on('data', (b: string) => { stderr = collect(stderr, b); });
      const kill = () => { stopped = true; if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } } };
      const timer = setTimeout(kill, request.timeoutMs); signal?.addEventListener('abort', kill, { once: true });
      child.once('error', error => { clearTimeout(timer); signal?.removeEventListener('abort', kill); reject(error); });
      child.once('close', code => {
        clearTimeout(timer); signal?.removeEventListener('abort', kill);
        const interrupted = stopped; kill(); // Kill background descendants on normal completion too.
        if (interrupted) reject(new Error('Execution aborted or timed out; outcome may be unknown'));
        else if (code === 125) reject(new Error(`Sandbox unavailable: ${stderr.slice(0, 2000)}`));
        else resolve({ code: code ?? 1, stdout, stderr, truncated });
      });
      child.stdin!.on('error', () => {}); child.stdin!.end(JSON.stringify(request));
    });
  }
}
