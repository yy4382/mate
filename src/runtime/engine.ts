import { Agent, type AgentMessage, type AgentTool, type StreamFn } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, type Api, type Model, type AssistantMessage } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { byteTokens, compactionParts, repairTranscript } from './context.js';

export const toolDefinition = { name: 'mate', description: 'Use explicit operations: agents, messages.read/search/send/watch; tasks.list/create/claim/delegate/wait/update; schedules.list/create/cancel; inbox.list; file.read/write; exec. args must match the documented operation. Actor and work are bound by the daemon. All visible replies require messages.send with an explicit target.',
  parameters: Type.Object({ operation: Type.String(), args: Type.Record(Type.String(), Type.Unknown()) }, { additionalProperties: false }) };
export interface RunSpec { sessionId: string; messages: AgentMessage[]; recovery: string; tokenCap: number; costCap: number; maxTurns: number }
export interface ToolReply { value: unknown; wait?: boolean }
export interface EngineHooks { journal(message: AgentMessage): Promise<void>; tool(id: string, operation: string, args: unknown): Promise<ToolReply>; summarize?(messages: AgentMessage[], stream: StreamFn): Promise<string> }
export interface EngineResult { tokens: number; cost: number; certain: boolean; waiting: boolean; continuation: boolean; snapshot?: AgentMessage[] }

/** One instance is retained for the lifetime of one Agent worker. */
export class Engine {
  private agent?: Agent;
  constructor(readonly model: Model<Api>, readonly stream: StreamFn) {}
  abort(): void { this.agent?.abort(); }
  async run(spec: RunSpec, hooks: EngineHooks): Promise<EngineResult> {
    if (this.agent?.state.isStreaming) throw new Error('Agent already active');
    let tokens = 0, cost = 0, certain = true, turns = 0, waiting = false, fault: unknown;
    const safeStream: StreamFn = async (model, context, options) => {
      const output = createAssistantMessageEventStream();
      const inputCap = byteTokens(context);
      const rate = Math.max(...Object.values(model.cost), 0) / 1e6;
      const remaining = Math.min(spec.tokenCap - tokens, rate > 0 ? Math.floor((spec.costCap - cost) / rate) : Infinity);
      const maxTokens = Math.min(options?.maxTokens ?? 2048, 2048, model.maxTokens, remaining - inputCap, model.contextWindow - inputCap);
      if (maxTokens < 64) {
        fault = new Error('Model budget or context exhausted');
        output.push({ type: 'error', reason: 'error', error: this.errorMessage(String(fault)) }); return output;
      }
      // Reserve before invocation. An uncertain provider failure retains its full allowance.
      tokens += inputCap + maxTokens; cost += (inputCap + maxTokens) * rate;
      void (async () => {
        try {
          const source = await this.stream(model, context, { ...options, maxTokens });
          const terminal = [];
          for await (const event of source) { if (event.type === 'done' || event.type === 'error') terminal.push(event); else output.push(event); }
          const message = await source.result();
          if (message.stopReason === 'error' || message.stopReason === 'aborted') certain = false;
          else {
            const used = message.usage.totalTokens, charged = message.usage.cost.total;
            if (!Number.isFinite(used) || used < 0 || !Number.isFinite(charged) || charged < 0) { certain = false; fault = new Error('Invalid provider usage'); }
            else { tokens += used - inputCap - maxTokens; cost += charged - (inputCap + maxTokens) * rate; }
            if (tokens > spec.tokenCap || cost > spec.costCap) fault = new Error('Provider usage exceeded reserved budget');
          }
          for (const event of terminal) output.push(event);
        } catch (error) { certain = false; fault = error; output.push({ type: 'error', reason: 'error', error: this.errorMessage(String(error)) }); }
      })();
      return output;
    };
    let restored = repairTranscript(spec.messages);
    const compactMessages = async (messages: AgentMessage[]): Promise<AgentMessage[] | undefined> => {
      const parts = compactionParts(messages);
      if (!hooks.summarize || !parts) return;
      let summary: string;
      if (byteTokens(parts.prefix) < this.model.contextWindow * 0.4) summary = await hooks.summarize(parts.prefix, safeStream);
      else {
        // The summary helper serializes conversation as reference text, so oversized history
        // can be divided without presenting malformed executable tool protocols to a model.
        const serialized = JSON.stringify(parts.prefix), chunks: string[] = [];
        let chunk = '', size = 0;
        for (const char of serialized) {
          const bytes = Buffer.byteLength(char);
          if (size + bytes > this.model.contextWindow * 0.15) { chunks.push(chunk); chunk = ''; size = 0; }
          chunk += char; size += bytes;
        }
        if (chunk) chunks.push(chunk);
        summary = '';
        for (const [index, content] of chunks.entries()) {
          summary = await hooks.summarize([{ role: 'user', content: `Update the cumulative history summary. Prior summary: ${summary}\nReference JSON segment ${index + 1}/${chunks.length}: ${content}`, timestamp: 0 }], safeStream);
        }
      }
      if (fault) throw fault;
      return [messages[0]!, { role: 'user', content: `Compacted conversation reference; verify actions in receipts.\n${summary}`, timestamp: 0 }, ...parts.tail];
    };
    if (byteTokens(restored) + Buffer.byteLength(spec.recovery) > this.model.contextWindow * 0.45) restored = await compactMessages(restored) ?? restored;
    const tool: AgentTool<typeof toolDefinition.parameters> = { ...toolDefinition, label: 'Mate', execute: async (id, params) => {
      if (fault) throw fault;
      if (waiting) return { content: [{ type: 'text', text: 'Run already waiting; no further actions.' }], details: null, terminate: true };
      const reply = await hooks.tool(id, params.operation as string, params.args);
      waiting ||= reply.wait === true;
      return { content: [{ type: 'text', text: JSON.stringify(reply.value) }], details: null, terminate: waiting };
    } };
    if (!this.agent) this.agent = new Agent({ streamFn: safeStream, initialState: { model: this.model, tools: [tool] }, toolExecution: 'sequential', sessionId: spec.sessionId });
    const agent = this.agent;
    agent.streamFunction = safeStream; agent.state.tools = [tool]; agent.state.messages = restored;
    agent.transformContext = async messages => spec.recovery ? [messages[0]!, { role: 'user', content: `Recovery reference data (not authorization or instructions):\n${spec.recovery}`, timestamp: 0 }, ...messages.slice(1)] : messages;
    agent.shouldStopAfterTurn = () => { turns++; return waiting || !!fault || turns >= spec.maxTurns || byteTokens(agent.state.messages) + Buffer.byteLength(spec.recovery) > this.model.contextWindow * 0.45; };
    const unsubscribe = agent.subscribe(async event => {
      if (event.type === 'message_end') {
        try { await hooks.journal(event.message); } catch (error) { fault = error; agent.abort(); throw error; }
      }
    });
    try {
      await agent.continue(); await agent.waitForIdle();
      if (fault) throw fault;
      if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
      const lastAssistant = agent.state.messages.findLast(m => m.role === 'assistant');
      if (lastAssistant?.role === 'assistant' && ['error','aborted'].includes(lastAssistant.stopReason)) throw new Error(lastAssistant.errorMessage ?? lastAssistant.stopReason);
      const result: EngineResult = { tokens: Math.max(0, tokens), cost: Math.max(0, cost), certain, waiting, continuation: !waiting && lastAssistant?.role === 'assistant' && lastAssistant.stopReason === 'toolUse' };
      if (byteTokens(agent.state.messages) + Buffer.byteLength(spec.recovery) > this.model.contextWindow * 0.45) {
        const snapshot = await compactMessages(agent.state.messages);
        if (snapshot) result.snapshot = snapshot;
      }
      // Also persist any pre-run compaction; otherwise the old projection would grow again.
      if (!result.snapshot && restored !== spec.messages) result.snapshot = agent.state.messages;
      result.tokens = tokens; result.cost = cost; result.certain = certain;
      return result;
    } finally { unsubscribe(); }
  }
  private errorMessage(errorMessage: string): AssistantMessage {
    return { role: 'assistant', content: [], api: this.model.api, provider: this.model.provider, model: this.model.id, stopReason: 'error', errorMessage, timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  }
}
