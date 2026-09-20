import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { relative } from 'node:path';
import { z } from 'zod';
import { checkedPath } from './paths.js';
import { operationSchema, type ExecutionBackend, type ExecutionRequest, type ExecutionResult } from './backend.js';

export interface ContainerConfig { binary: string; image: string; host: string; scope: string }
export class ContainerBackend implements ExecutionBackend {
  constructor(private config: ContainerConfig) {
    z.string().startsWith('/').parse(config.binary);
    z.string().regex(/^sha256:[a-f0-9]{64}$/).parse(config.image);
    z.string().startsWith('unix:///').parse(config.host);
    z.string().regex(/^[a-z0-9-]{1,80}$/).parse(config.scope);
  }
  /** Startup only, after the daemon lock: kill executions orphaned by its previous process. */
  async recover(): Promise<void> {
    const list = await this.command(['ps', '--all', '--filter', `label=mate.execution=${this.config.scope}`, '--format', '{{.ID}}'], 10000);
    if (list.code !== 0) throw new Error('Cannot inspect orphaned containers');
    for (const id of list.stdout.trim().split('\n').filter(Boolean)) {
      if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error('Invalid container identity');
      const result = await this.command(['rm', '--force', '--volumes', id], 10000);
      if (result.code !== 0) throw new Error('Cannot remove orphaned execution');
    }
  }
  private command(args: string[], timeoutMs: number, signal?: AbortSignal): Promise<ExecutionResult> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new Error('Container command aborted')); return; }
      const child = spawn(this.config.binary, ['--host', this.config.host, ...args], {
        env: { PATH: '/usr/bin:/bin:/usr/local/bin' }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '', truncated = false, interrupted = false;
      const append = (old: string, data: Buffer) => { if (old.length + data.length > 65536) truncated = true; return (old + data.toString()).slice(0, 65536); };
      child.stdout.on('data', (b: Buffer) => { stdout = append(stdout, b); }); child.stderr.on('data', (b: Buffer) => { stderr = append(stderr, b); });
      const stop = () => { interrupted = true; child.kill('SIGKILL'); };
      const timer = setTimeout(stop, timeoutMs); signal?.addEventListener('abort', stop, { once: true });
      child.once('error', e => { clearTimeout(timer); signal?.removeEventListener('abort', stop); reject(e); });
      child.once('close', code => {
        clearTimeout(timer); signal?.removeEventListener('abort', stop);
        if (interrupted) reject(new Error('Container command aborted or timed out'));
        else resolve({ code: code ?? 1, stdout, stderr, truncated });
      });
    });
  }
  async execute(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult> {
    const op = operationSchema.parse(request.operation);
    if (op.kind !== 'exec') throw new Error('Container backend accepts exec only');
    z.number().int().min(1).max(300000).parse(request.timeoutMs);
    const root = realpathSync(request.root); if (root !== request.root || root.includes(',')) throw new Error('Invalid container mount root');
    const cwd = checkedPath(root, op.cwd), name = `mate-exec-${randomUUID()}`;
    const deadline = Date.now() + request.timeoutMs;
    let result: ExecutionResult | undefined, failure: unknown;
    try {
      const create = await this.command(['create', '--name', name, '--pull', 'never', '--network', 'none', '--read-only', '--log-driver', 'none', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '512m', '--cpus', '1',
        '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, '--tmpfs', '/tmp:rw,nosuid,nodev,size=67108864',
        '--mount', `type=bind,src=${root},dst=/workspace`, '--workdir', `/workspace/${relative(root, cwd)}`,
        '--label', `mate.execution=${this.config.scope}`, this.config.image, '/bin/sh', '-c', op.command], Math.max(1, deadline - Date.now()), signal);
      if (create.code !== 0) throw new Error(`Container creation failed: ${create.stderr.slice(0, 2000)}`);
      result = await this.command(['start', '--attach', name], Math.max(1, deadline - Date.now()), signal);
    } catch (error) { failure = error; }
    // Do not report completion until the PID namespace has been destroyed.
    // This also handles create succeeding remotely while its CLI was interrupted.
    const cleanup = await this.command(['rm', '--force', '--volumes', name], 10000);
    if (cleanup.code !== 0 && !/No such container/i.test(cleanup.stderr)) throw new Error(`Container cleanup unconfirmed: ${name}`);
    if (failure) throw failure;
    return result!;
  }
}
export class ControlledBackend implements ExecutionBackend {
  constructor(private files: ExecutionBackend, private commands: ExecutionBackend) {}
  execute(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult> {
    return (request.operation.kind === 'exec' ? this.commands : this.files).execute(request, signal);
  }
}
