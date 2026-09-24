/** Trusted platform lifecycle. Poll is local replay; flush owns bounded network work.
 * Daemon never awaits flush before scheduling internal work. close is idempotent,
 * cancels startup/network work and settles owned resources before DB lock release.
 */
export interface AdapterLifecycle {
  start(signal: AbortSignal, progress?: () => void): Promise<void>;
  recover(): void;
  poll(): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}
