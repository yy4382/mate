import type { App, Receiver, ReceiverEvent } from "@slack/bolt";
import type { Store } from "../storage/store.js";
import { z } from "zod";

const bodySchema = z
  .object({
    api_app_id: z.string().optional(),
    event_id: z.string().optional(),
    team_id: z.string().optional(),
  })
  .passthrough();
export interface Envelope {
  envelope_id: string;
  body: Record<string, unknown>;
  ack: () => Promise<unknown>;
}
export interface SocketTransport {
  on(event: string, listener: (event: Envelope) => void): unknown;
  /** The connection dropped; the owner of this socket decides how it recovers. */
  onDisconnect(listener: () => void): void;
  start(): Promise<unknown>;
  disconnect(): Promise<unknown>;
}
/** Bind app/team from installed connection, never from model supplied metadata. */
export class DurableReceiver implements Receiver {
  private app?: App;
  constructor(
    private store: Store,
    private appId: string,
    private teamId: string,
    private socket: SocketTransport,
    private reportError: (error: unknown) => void,
    private committed?: () => void,
  ) {
    socket.on("slack_event", (event: Envelope) => {
      void this.receive(event).catch(reportError);
    });
  }
  init(app: App): void {
    this.app = app;
  }
  start(): Promise<unknown> {
    return this.socket.start();
  }
  stop(): Promise<unknown> {
    return this.socket.disconnect();
  }
  async receive(event: Envelope): Promise<void> {
    const body = bodySchema.parse(event.body);
    if (body.api_app_id && body.api_app_id !== this.appId)
      throw new Error("Slack app identity mismatch");
    if (body.team_id && body.team_id !== this.teamId)
      throw new Error("Slack workspace identity mismatch");
    const nestedTeam = (body.team as { id?: string } | undefined)?.id;
    if (nestedTeam && nestedTeam !== this.teamId)
      throw new Error("Slack workspace identity mismatch");
    if (!event.envelope_id) throw new Error("Missing envelope identity");
    this.store.ingest(this.appId, body.event_id ?? event.envelope_id, body);
    await event.ack(); // A failed commit above must never acknowledge Slack.
    this.committed?.();
    // Durable replay drives business handlers, Bolt can consume metadata without a second ack.
    if (this.app) {
      const received: ReceiverEvent = { body, ack: async () => {} };
      void this.app.processEvent(received).catch(this.reportError);
    }
  }
}
