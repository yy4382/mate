import { expect, it } from "vitest";
import { Store } from "../../src/storage/store.js";
import { UsageLedger } from "../../src/usage/ledger.js";
import { answer } from "../helpers/pi.js";

it("records each provider call before execution and retains unknown usage after interruption", () => {
  const store = new Store(":memory:");
  try {
    store.register("research", "v1", []);
    store.enqueue("research", "first", {});
    const run = store.beginRun("research")!;
    const ledger = new UsageLedger(store);
    ledger.begin(run, null, 1, "openai", "synthetic");
    expect(ledger.readAgent("research")).toMatchObject({
      knownCalls: 0,
      unknownCalls: 1,
      totalTokens: 0,
    });
    ledger.complete(run, 1, answer([{ type: "text", text: "ok" }]));
    ledger.begin(run, null, 2, "openai", "synthetic");
    store.db.prepare("UPDATE runs SET state='interrupted' WHERE id=?").run(run.id);
    expect(ledger.readAgent("research")).toMatchObject({
      knownCalls: 1,
      unknownCalls: 1,
      totalTokens: 12,
    });
    expect(UsageLedger.summaryFrom(store.db, "research")).toEqual(ledger.readAgent("research"));
    expect(() => ledger.complete(run, 2, answer([{ type: "text", text: "too late" }]))).toThrow(
      "Stale or stopped run",
    );
  } finally {
    store.close();
  }
});

it("rejects duplicate call identities and responses from a different model", () => {
  const store = new Store(":memory:");
  try {
    store.register("research", "v1", []);
    store.enqueue("research", "first", {});
    const run = store.beginRun("research")!;
    const ledger = new UsageLedger(store);
    ledger.begin(run, null, 1, "openai", "synthetic");
    expect(() => ledger.begin(run, null, 1, "openai", "synthetic")).toThrow();
    expect(() => ledger.complete(run, 1, { ...answer([]), model: "different" })).toThrow(
      "not awaiting completion",
    );
    expect(ledger.complete(run, 1, { ...answer([]), usage: undefined } as never)).toBe(false);
    expect(ledger.readAgent("research").unknownCalls).toBe(1);
  } finally {
    store.close();
  }
});
