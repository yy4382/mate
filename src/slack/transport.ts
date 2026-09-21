import { WebClient } from '@slack/web-api';
import type { Target } from '../conversations/messages.js';
import type { MessageTransport } from '../conversations/output.js';
import { encode, hash } from '../storage/store.js';
/** No automatic write retries: the durable outbox owns uncertainty. */
export class WebSlackTransport implements MessageTransport {
  readonly clients = new Map<string, WebClient>();
  constructor(tokens: Record<string, string>) {
    for (const [agent, token] of Object.entries(tokens)) this.clients.set(agent, new WebClient(token, {
      retryConfig: { retries: 0 }, rejectRateLimitedCalls: true, timeout: 15000,
    }));
  }
  async post(agentId: string, target: Target, text: string, id: string): Promise<{ ts: string }> {
    const client = this.clients.get(agentId); if (!client) throw new Error('Missing Slack client');
    const response = await client.chat.postMessage({ channel: target.channel, ...(target.thread ? { thread_ts: target.thread } : {}), text,
      metadata: { event_type: 'mate_outbox', event_payload: { id, request_hash: hash(encode({ target, text })) } }, unfurl_links: false, unfurl_media: false });
    if (!response.ts) throw new Error('Missing Slack receipt'); return { ts: response.ts };
  }
}
