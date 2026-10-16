import { createConnection, createServer, type Server, type Socket } from "node:net";

/**
 * - `forward`: bytes pass both ways.
 * - `blackhole`: connections stay open but every byte in either direction is swallowed, as on a dead route.
 * - `disconnect`: every open connection is dropped, and new ones are dropped as soon as they arrive.
 */
export type NetworkMode = "forward" | "blackhole" | "disconnect";

/** A TCP proxy between a node and the control plane whose network the test controls. */
export class NetworkProxy {
  readonly #target: { host: string; port: number };
  readonly #server: Server;
  readonly #links = new Set<Socket>();
  #mode: NetworkMode = "forward";
  #connections = 0;

  constructor(target: { host: string; port: number }) {
    this.#target = target;
    this.#server = createServer((client) => this.#accept(client));
  }

  /** Start listening on a free local port. */
  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.#server.listen(0, "127.0.0.1", resolve));
  }

  get port(): number {
    const address = this.#server.address();
    if (address === null || typeof address === "string") throw new Error("proxy not started");
    return address.port;
  }

  /** How many connections have arrived at the proxy, whatever happened to them. */
  get connections(): number {
    return this.#connections;
  }

  setMode(mode: NetworkMode): void {
    this.#mode = mode;
    if (mode === "disconnect") for (const socket of this.#links) socket.destroy();
  }

  async close(): Promise<void> {
    for (const socket of this.#links) socket.destroy();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  #accept(client: Socket): void {
    this.#connections++;
    if (this.#mode === "disconnect") {
      client.destroy();
      return;
    }
    const upstream = createConnection(this.#target);
    for (const [from, to] of [
      [client, upstream],
      [upstream, client],
    ] as const) {
      this.#links.add(from);
      from.on("data", (bytes) => {
        if (this.#mode === "forward") to.write(bytes);
      });
      from.on("close", () => {
        this.#links.delete(from);
        to.destroy();
      });
      from.on("error", () => {
        // close follows and tears down the other side
      });
    }
  }
}
