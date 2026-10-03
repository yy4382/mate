export type CleanupReport = {
  released: string[];
  failures: Array<{ resource: string; error: unknown }>;
};

export type CleanupAction = (signal: AbortSignal) => void | Promise<void>;

function createCleanupResource(name: string, action: CleanupAction) {
  let inFlight: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let released = false;
  return {
    name,
    start() {
      if (released) return Promise.resolve();
      if (inFlight) return inFlight;
      const current = new AbortController();
      controller = current;
      inFlight = Promise.resolve()
        .then(() => action(current.signal))
        .then(
          () => {
            released = true;
          },
          (error: unknown) => {
            inFlight = undefined;
            throw error;
          },
        );
      return inFlight;
    },
    cancel(reason: Error) {
      controller?.abort(reason);
    },
  };
}
/** Owns retryable release and evidence collection; it does not start or restart services. */
export class ScenarioResources {
  private readonly resources = new Map<symbol, ReturnType<typeof createCleanupResource>>();
  private readonly collectors = new Map<string, CleanupAction>();
  readonly reports: CleanupReport[] = [];
  collectingEvidence = false;
  private closing: Promise<CleanupReport> | undefined;

  constructor(private readonly timeoutMs: number) {}

  get names() {
    return [...this.resources.values()].map((resource) => resource.name);
  }

  register(name: string, action: CleanupAction) {
    this.resources.set(Symbol(name), createCleanupResource(name, action));
  }

  beforeClose(name: string, action: CleanupAction) {
    if (this.collectors.has(name))
      throw new Error(`Before-close action already registered: ${name}`);
    this.collectors.set(name, action);
  }

  private async release(resource: ReturnType<typeof createCleanupResource>) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        resource.start(),
        new Promise<void>((_resolve, reject) => {
          timer = setTimeout(() => {
            const error = new Error(`Scenario cleanup timed out: ${resource.name}`);
            resource.cancel(error);
            reject(error);
          }, this.timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<CleanupReport> {
    if (this.closing) return this.closing;
    this.closing = Promise.resolve().then(async () => {
      const report: CleanupReport = { released: [], failures: [] };
      this.collectingEvidence = true;
      for (const [name, collect] of this.collectors) {
        try {
          await this.release(createCleanupResource(`before close: ${name}`, collect));
        } catch (error) {
          report.failures.push({ resource: `before close: ${name}`, error });
        } finally {
          this.collectors.delete(name);
        }
      }
      this.collectingEvidence = false;
      for (const [id, resource] of [...this.resources].reverse()) {
        try {
          await this.release(resource);
          this.resources.delete(id);
          report.released.push(resource.name);
        } catch (error) {
          report.failures.push({ resource: resource.name, error });
        }
      }
      this.reports.push(report);
      return report;
    });
    try {
      return await this.closing;
    } finally {
      this.closing = undefined;
    }
  }
}
