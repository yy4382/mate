import type { SlackInstallationReadiness } from "../slack/readiness.js";

/** What an adapter reports about its external installations, separate from this process running. */
export interface AdapterReadiness {
  /** True only when every installation this adapter serves is ready for platform work. */
  ready: boolean;
  installations: SlackInstallationReadiness[];
}
/** Trusted platform lifecycle. Poll is local replay; flush owns bounded network work.
 * Daemon never awaits flush before scheduling internal work. close is idempotent,
 * cancels startup/network work and settles owned resources before DB lock release.
 * start returns once the adapter serves this process; connecting and history catch-up continue
 * in the background and are reported through readiness(), never by failing this startup.
 */
export interface AdapterLifecycle {
  start(signal: AbortSignal, progress?: () => void): Promise<void>;
  recover(): void;
  poll(): void;
  flush(): Promise<void>;
  close(): Promise<void>;
  /** Present on adapters that serve external installations. */
  readiness?(): AdapterReadiness;
}
