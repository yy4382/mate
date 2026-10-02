import { connect, createServer, type Socket } from "node:net";
import { z } from "zod";
import { waitForScenario, type ScenarioWaitOptions } from "./scenario-driver.js";

const identitySchema = z.object({
  type: z.string(),
  requestId: z.string().optional(),
  operationId: z.string().optional(),
  runId: z.string().optional(),
  agentId: z.string().optional(),
});
const eventSchema = identitySchema.partial().extend({
  sequence: z.number(),
  connectionId: z.number(),
  kind: z.enum(["connected", "blocked", "closed", "frame", "disconnect", "blackhole", "restore"]),
  direction: z.enum(["node-to-control", "control-to-node"]).optional(),
  opcode: z.number().optional(),
  dropped: z.boolean().optional(),
  openSockets: z.number().optional(),
});
export type NodeLinkEvent = z.output<typeof eventSchema>;

// Same raw TCP/frame observation as nodes-process.test.ts. No WebSocket endpoint is created, so
// the observer cannot answer ping/pong or synthesize either side's heartbeat.
function frameObserver(emit: (opcode: number, payload: Buffer, dropped: boolean) => void) {
  let bytes = Buffer.alloc(0);
  let upgraded = false;
  let droppedBytes = false;
  return (chunk: Buffer, dropped: boolean) => {
    bytes = Buffer.concat([bytes, chunk]);
    droppedBytes ||= dropped;
    if (!upgraded) {
      const end = bytes.indexOf("\r\n\r\n");
      if (end < 0) return;
      bytes = bytes.subarray(end + 4);
      upgraded = true;
    }
    while (bytes.length >= 2) {
      const first = bytes.readUInt8(0);
      const second = bytes.readUInt8(1);
      let length = second & 0x7f;
      let header = 2;
      if (length === 126) {
        if (bytes.length < 4) return;
        length = bytes.readUInt16BE(2);
        header = 4;
      } else if (length === 127) {
        if (bytes.length < 10) return;
        const large = bytes.readBigUInt64BE(2);
        if (large > 16_777_216n) throw new Error("Scenario node frame exceeds observation limit");
        length = Number(large);
        header = 10;
      }
      const masked = (second & 0x80) !== 0;
      const end = header + (masked ? 4 : 0) + length;
      if (bytes.length < end) return;
      const payload = Buffer.from(bytes.subarray(header + (masked ? 4 : 0), end));
      if (masked)
        for (let index = 0; index < payload.length; index++)
          payload[index] = payload.readUInt8(index) ^ bytes.readUInt8(header + (index % 4));
      emit(first & 0x0f, payload, droppedBytes);
      bytes = bytes.subarray(end);
      if (bytes.length === 0) droppedBytes = false;
    }
  };
}

/** Controls only the configured node URL. New connections stay blocked until explicit restore. */
export async function createScenarioNodeLink(
  targetOrigin: string,
  lifecycle: { signal: AbortSignal; registerCleanup: (close: () => Promise<void>) => void },
) {
  lifecycle.signal.throwIfAborted();
  const target = new URL(targetOrigin);
  const sockets = new Set<Socket>();
  const events: NodeLinkEvent[] = [];
  let mode = z.enum(["forward", "blackhole", "disconnect", "closed"]).parse("forward");
  let connections = 0;
  function emit(event: Omit<NodeLinkEvent, "sequence">) {
    events.push({ ...event, sequence: events.length + 1 });
  }
  function track(socket: Socket) {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    return socket;
  }
  const server = createServer((client) => {
    const connectionId = ++connections;
    track(client);
    client.pause();
    if (mode !== "forward") {
      emit({ kind: "blocked", connectionId });
      return;
    }
    const upstream = track(connect(Number(target.port), target.hostname));
    emit({ kind: "connected", connectionId });
    function observer(direction: "node-to-control" | "control-to-node") {
      return frameObserver((opcode, payload, dropped) => {
        let identity: z.output<typeof identitySchema> | undefined;
        if (opcode === 1) {
          try {
            const parsed = identitySchema.safeParse(JSON.parse(payload.toString("utf8")));
            if (parsed.success) identity = parsed.data;
          } catch {
            /* Control frames and partial message fragments have no JSON identity. */
          }
        }
        emit({ kind: "frame", connectionId, direction, opcode, dropped, ...identity });
      });
    }
    const fromNode = observer("node-to-control");
    const fromControl = observer("control-to-node");
    upstream.once("connect", () => client.resume());
    client.on("data", (data: Buffer) => {
      const dropped = mode !== "forward";
      fromNode(data, dropped);
      if (!dropped) upstream.write(data);
    });
    upstream.on("data", (data: Buffer) => {
      const dropped = mode !== "forward";
      fromControl(data, dropped);
      if (!dropped) client.write(data);
    });
    client.once("close", () => {
      emit({ kind: "closed", connectionId, direction: "node-to-control" });
      if (mode === "forward") upstream.destroy();
    });
    upstream.once("close", () => {
      emit({ kind: "closed", connectionId, direction: "control-to-node" });
      if (mode === "forward") client.destroy();
    });
  });
  async function close() {
    mode = "closed";
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error && !("code" in error && error.code === "ERR_SERVER_NOT_RUNNING")) reject(error);
        else resolve();
      }),
    );
  }
  // Ownership precedes asynchronous listen, including cancellation or partial startup failure.
  lifecycle.registerCleanup(close);
  lifecycle.signal.throwIfAborted();
  const listening = new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  await waitForScenario(
    "node link TCP listener",
    () => listening,
    () => true,
    { signal: lifecycle.signal },
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Node link has no TCP port");
  function change(next: "blackhole" | "disconnect" | "forward") {
    if (mode === "closed") throw new Error("Node link is closed");
    mode = next;
    emit({
      kind: next === "forward" ? "restore" : next,
      connectionId: connections,
      openSockets: sockets.size,
    });
    if (next !== "blackhole") for (const socket of sockets) socket.destroy();
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    events,
    observe: () => events.length,
    blackhole: () => change("blackhole"),
    disconnect: () => change("disconnect"),
    restore: () => change("forward"),
    async waitFor(
      matches: (event: NodeLinkEvent) => boolean,
      options: ScenarioWaitOptions & { after: number },
    ) {
      const observed = await waitForScenario(
        `node link event after ${options.after}`,
        () => ({
          mode,
          lastEvent: events.at(-1),
          events: events.filter((event) => event.sequence > options.after),
        }),
        (facts) => facts.events.some(matches),
        options,
      );
      const event = observed.events.find(matches);
      if (!event) throw new Error("Matched node link event is missing");
      return event;
    },
    close,
  };
}
