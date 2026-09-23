import { SocketModeClient } from '@slack/socket-mode';
import type { FetchFunction } from '@slack/web-api';
import type { Envelope, SocketTransport } from './receiver.js';
/** Bound SDK startup and prevent its late retrieveWSSURL continuation from reconnecting after stop. */
export class ManagedSocket implements SocketTransport {
  readonly client: SocketModeClient;
  private closed = false;
  private abort = new AbortController();
  private rejectStart?: (error: Error) => void;
  constructor(appToken: string, transport: FetchFunction = globalThis.fetch) {
    this.client = new SocketModeClient({ appToken, clientOptions: { retryConfig: { retries: 0 }, timeout: 15000,
      fetch: async (input, init) => {
        this.abort.signal.throwIfAborted();
        const response = await transport(input, { ...init, signal: AbortSignal.any([this.abort.signal, ...(init?.signal ? [init.signal] : [])]) });
        this.abort.signal.throwIfAborted(); return response;
      }
    } });
    this.client.on('connecting', () => {
      if (!this.closed) return;
      // SDK start() awaits its HTTP URL before assigning websocket, even after disconnect().
      const late = this.client.websocket; delete this.client.websocket;
      late?.disconnect(); this.client.emit('disconnected', new Error('Socket stopped'));
    });
  }
  on(event: string, listener: (event: Envelope) => void): unknown { return this.client.on(event, value => { if (!this.closed) listener(value); }); }
  onDisconnect(listener:()=>void):void{this.client.on('close',()=>{if(!this.closed)listener();});}
  async start(): Promise<unknown> {
    if (this.closed) throw new Error('Socket closed');
    const cancelled = new Promise<never>((_resolve, reject) => { this.rejectStart = reject; });
    const timer = setTimeout(() => { void this.disconnect(); }, 30000);
    try { return await Promise.race([this.client.start(), cancelled]); }
    finally { clearTimeout(timer); delete this.rejectStart; }
  }
  async disconnect(): Promise<void> {
    this.closed = true; this.abort.abort(); this.rejectStart?.(new Error('Socket start cancelled'));
    // SDK closes sockets and bounds the close handshake itself.
    await this.client.disconnect();
  }
}
