import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
export const operationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('read'), path: z.string().max(4096) }).strict(),
  z.object({ kind: z.literal('write'), path: z.string().max(4096), content: z.string().max(1000000) }).strict(),
  z.object({ kind: z.literal('exec'), command: z.string().min(1).max(16000), cwd: z.string().max(4096) }).strict(),
]);
export type Operation = z.infer<typeof operationSchema>;
export interface ExecutionRequest { root: string; operation: Operation; timeoutMs: number }
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
      const collect = (value: string, chunk: Buffer): string => { if (Buffer.byteLength(value) + chunk.length > limit) truncated = true; return (value + chunk.toString()).slice(0, limit); };
      child.stdout!.on('data', (b: Buffer) => { stdout = collect(stdout, b); });
      child.stderr!.on('data', (b: Buffer) => { stderr = collect(stderr, b); });
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
