// Runs inside the OS sandbox, never imported into the daemon.
import { constants, openSync, readSync, readFileSync, closeSync, writeFileSync, renameSync, mkdirSync, statSync, unlinkSync, existsSync, readdirSync, fsyncSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
const root = process.argv[2]!;
const operation = JSON.parse(process.argv[3]!) as { kind: 'read' | 'write'; path: string; content?: string };
const path = resolve(root, operation.path), rel = relative(root, path);
if (isAbsolute(rel) || rel === '..' || rel.startsWith('../')) throw new Error('Path escapes root');
if (operation.kind === 'read') {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const buffer = Buffer.alloc(65537), count = readSync(fd, buffer, 0, buffer.length, 0); if (count > 65536) throw new Error('File exceeds read limit'); process.stdout.write(buffer.subarray(0, count)); } finally { closeSync(fd); }
} else {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    if (existsSync(path)) {
      if (statSync(path).size > 1000000) throw new Error('Existing file exceeds revision limit');
      const history = `${path}.history`; mkdirSync(history, { recursive: true });
      writeFileSync(`${history}/${Date.now()}-${randomUUID()}`, readFileSync(path), { flag: 'wx', mode: 0o600 });
      for (const old of readdirSync(history).sort().slice(0, -5)) unlinkSync(`${history}/${old}`);
    }
    writeFileSync(temp, operation.content!, { flag: 'wx', mode: 0o600 });
    const fd = openSync(temp, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
    const dir = openSync(dirname(path), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
    process.stdout.write(JSON.stringify({ sha256: createHash('sha256').update(operation.content!).digest('hex') }));
  } finally { try { unlinkSync(temp); } catch { /* renamed already */ } }
}
