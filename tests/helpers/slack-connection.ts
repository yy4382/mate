import type { Envelope, SocketTransport } from "../../src/slack/receiver.js";

/**
 * A Socket Mode stand-in whose connect, failure and drop are decided by the test. It keeps the
 * production connection owner honest without any real Slack credential or network access.
 */
export class ControllableSocket implements SocketTransport {
  readonly listeners = new Map<string, (event: Envelope) => void>();
  private drops: (() => void)[] = [];
  private gate?: Promise<void> | undefined;
  private open?: (() => void) | undefined;
  private cancel?: ((error: Error) => void) | undefined;
  starts = 0;
  disconnects = 0;
  /** The next start() rejects with this; a successful start clears it. */
  fail?: unknown;
  on(event: string, listener: (event: Envelope) => void): this {
    this.listeners.set(event, listener);
    return this;
  }
  onDisconnect(listener: () => void): void {
    this.drops.push(listener);
  }
  /** Keep the next start() pending until release() or disconnect() is called. */
  hold(): void {
    this.gate = new Promise<void>((resolve, reject) => {
      this.open = resolve;
      this.cancel = reject;
    });
  }
  release(): void {
    this.open?.();
    this.gate = undefined;
    this.open = undefined;
    this.cancel = undefined;
  }
  /** The connection dropped underneath the runtime. */
  drop(): void {
    for (const listener of [...this.drops]) listener();
  }
  async start(): Promise<unknown> {
    this.starts++;
    const failure = this.fail;
    if (failure) {
      this.fail = undefined;
      throw failure;
    }
    if (this.gate) await this.gate;
    return {};
  }
  async disconnect(): Promise<unknown> {
    this.disconnects++;
    // A socket being closed cancels its pending start, like the real Socket Mode client.
    this.cancel?.(new Error("Socket start cancelled"));
    this.release();
    return {};
  }
}
/** One scripted socket per connection attempt, in creation order, grouped by installation. */
export function slackSockets(
  configure: (socket: ControllableSocket, agentId: string) => void = () => {},
) {
  const created: { agentId: string; socket: ControllableSocket }[] = [];
  return {
    created,
    /** The most recent socket of one installation, or of every installation in creation order. */
    forAgent: (agentId: string) =>
      created.filter((entry) => entry.agentId === agentId).at(-1)?.socket,
    socket: (agent: { id: string }) => {
      const socket = new ControllableSocket();
      configure(socket, agent.id);
      created.push({ agentId: agent.id, socket });
      return socket;
    },
  };
}
