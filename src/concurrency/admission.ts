import { z } from "zod";

export interface Admission {
  acquire(signal?: AbortSignal): Promise<() => void>;
  snapshot(): { active: number; queued: number; limit: number };
}

/** Process-local FIFO admission. Durable work remains queued in Store; this only bounds live resource use. */
export class FairAdmission implements Admission {
  private active = 0;
  private readonly queue: {
    signal?: AbortSignal;
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    abort?: () => void;
  }[] = [];
  readonly limit: number;
  constructor(limit: number) {
    this.limit = z.number().int().min(1).max(1024).parse(limit);
  }
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new Error("Admission cancelled"));
    return new Promise((resolve, reject) => {
      const entry: {
        signal?: AbortSignal;
        resolve: (release: () => void) => void;
        reject: (error: Error) => void;
        abort?: () => void;
      } = { resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) {
        entry.abort = () => {
          const index = this.queue.indexOf(entry);
          if (index >= 0) this.queue.splice(index, 1);
          reject(new Error("Admission cancelled"));
        };
        signal.addEventListener("abort", entry.abort, { once: true });
      }
      this.queue.push(entry);
      this.drain();
    });
  }
  snapshot() {
    return {
      active: this.active,
      queued: this.queue.length,
      limit: this.limit,
    };
  }
  private drain(): void {
    while (this.active < this.limit && this.queue.length) {
      const entry = this.queue.shift()!;
      if (entry.signal?.aborted) {
        entry.signal.removeEventListener("abort", entry.abort!);
        entry.reject(new Error("Admission cancelled"));
        continue;
      }
      if (entry.abort) entry.signal!.removeEventListener("abort", entry.abort);
      this.active++;
      let released = false;
      entry.resolve(() => {
        if (released) return;
        released = true;
        this.active--;
        this.drain();
      });
    }
  }
}
