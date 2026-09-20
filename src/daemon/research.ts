import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
/** Public IPv4 only, with a pinned DNS result: avoids redirect/rebinding access to local services. */
export function publicIPv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return a !== 0 && a !== 10 && a !== 127 && a! < 224 && !(a === 100 && b! >= 64 && b! <= 127) && !(a === 169 && b === 254) && !(a === 172 && b! >= 16 && b! <= 31) && !(a === 192 && [0, 168].includes(b!)) && !(a === 198 && [18,19,51].includes(b!)) && !(a === 203 && b === 0);
}
export class Research {
  constructor(readonly allowedHosts: string[]) {}
  async read(input: string, signal: AbortSignal, redirects = 0): Promise<{ url: string; contentType: string; body: string; truncated: boolean }> {
    signal = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
    signal.throwIfAborted();
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !this.allowedHosts.includes(url.hostname) || redirects > 3) throw new Error('Research URL outside configured public HTTPS hosts');
    let onAbort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => { onAbort = () => reject(new Error('Research aborted')); signal.addEventListener('abort', onAbort, { once: true }); });
    const addresses = await Promise.race([lookup(url.hostname, { all: true, family: 4 }), cancelled]).finally(() => signal.removeEventListener('abort', onAbort));
    if (!addresses.length || addresses.some(a => !publicIPv4(a.address))) throw new Error('Research address is not public');
    signal.throwIfAborted();
    const response = await new Promise<{ status: number; location?: string; contentType: string; body: string; truncated: boolean }>((resolve, reject) => {
      const req = request(url, { method: 'GET', signal, headers: { 'User-Agent': 'Mate/0.1', Accept: 'text/plain,text/html,application/json', 'Accept-Encoding': 'identity' },
        lookup: (_hostname, _options, callback) => callback(null, addresses.map(a => ({ address: a.address, family: 4 }))) }, res => {
        const chunks: Buffer[] = []; let bytes = 0, truncated = false;
        res.on('data', (chunk: Buffer) => { const room = 64000 - bytes; if (chunk.length > room) truncated = true; if (room > 0) chunks.push(chunk.subarray(0, room)); bytes += chunk.length; if (bytes > 64000) res.destroy(); });
        let done = false;
        const finish = () => { if (done) return; done = true; resolve({ status: res.statusCode ?? 0, ...(res.headers.location ? { location: res.headers.location } : {}), contentType: res.headers['content-type'] ?? '', body: Buffer.concat(chunks).toString('utf8'), truncated }); };
        res.on('end', finish); res.on('close', finish); res.on('error', reject);
      });
      req.setTimeout(10000, () => req.destroy(new Error('Research timeout'))); req.on('error', reject); req.end();
    });
    if (response.status >= 300 && response.status < 400 && response.location) return this.read(new URL(response.location, url).href, signal, redirects + 1);
    if (response.status !== 200 || !/^(text\/|application\/json)/i.test(response.contentType)) throw new Error('Unsupported research response');
    return { url: url.href, contentType: response.contentType, body: response.body, truncated: response.truncated };
  }
}
