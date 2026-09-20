import type { AgentMessage } from '@earendil-works/pi-agent-core';

/** Close interrupted calls with explicit uncertainty. Never fabricate execution success. */
export function repairTranscript(messages: AgentMessage[], receipt?: (id: string) => string | undefined): AgentMessage[] {
  const result: AgentMessage[] = [];
  let pending = new Map<string, string>();
  const close = () => {
    for (const [toolCallId, toolName] of pending) result.push({ role: 'toolResult', toolCallId, toolName,
      content: [{ type: 'text', text: receipt?.(toolCallId) ?? 'Interrupted before a durable tool result. Outcome unknown; inspect receipts/state before any retry.' }],
      isError: true, timestamp: 0 });
    pending = new Map();
  };
  for (const message of messages) {
    if (message.role !== 'toolResult') close();
    if (message.role === 'toolResult') {
      if (!pending.has(message.toolCallId)) continue; // exclude orphaned results from the model projection
      pending.delete(message.toolCallId);
    }
    result.push(message);
    if (message.role === 'assistant') for (const content of message.content) if (content.type === 'toolCall') pending.set(content.id, content.name);
  }
  close(); return result;
}
/** Cut only at user turns, retaining the latest complete turn and the immutable baseline. */
export function compactionParts(messages: AgentMessage[]): { prefix: AgentMessage[]; tail: AgentMessage[] } | undefined {
  const lastUser = messages.findLastIndex(m => m.role === 'user');
  if (lastUser <= 1) return;
  return { prefix: messages.slice(1, lastUser), tail: messages.slice(lastUser) };
}
export function byteTokens(messages: unknown): number { return Buffer.byteLength(JSON.stringify(messages), 'utf8') + 1024; }
