import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../../src/storage/store.js";
import { recoverSlackHistory, scanSlackPages } from "../../src/slack/history-recovery.js";

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
function setup() {
  const store = new Store(":memory:");
  stores.push(store);
  store.register("research", "v1", []);
  return store;
}
function options(
  store: Store,
  fetch: (state: {
    oldest: string | undefined;
    cursor: string | undefined;
  }) => Promise<{ messages: { ts: string }[]; next: string | undefined }>,
) {
  return {
    store,
    agentId: "research",
    cursorKey: "C",
    initialOldest: "10.000000",
    fetch,
    timestamp: (message: { ts: string }) => message.ts,
    ingest: vi.fn(),
  };
}

it("resumes from the page cursor persisted before a transient failure", async () => {
  const store = setup(),
    first = vi.fn(async ({ cursor }: { cursor: string | undefined }) => {
      if (cursor === "page-2") throw new Error("offline");
      return { messages: [{ ts: "11.000000" }], next: "page-2" };
    }),
    onPage = vi.fn(),
    input = { ...options(store, first), onPage };
  expect(await recoverSlackHistory(input)).toBe(false);
  const resumed = vi.fn(async () => ({
    messages: [{ ts: "12.000000" }],
    next: undefined,
  }));
  expect(await recoverSlackHistory({ ...input, fetch: resumed })).toBe(true);
  expect(resumed).toHaveBeenCalledWith({
    oldest: "10.000000",
    cursor: "page-2",
  });
  expect(
    store.db
      .prepare("SELECT ts FROM slack_cursors WHERE agent_id='research' AND channel='C'")
      .get(),
  ).toEqual({ ts: "12.000000" });
  expect(onPage).toHaveBeenCalledTimes(2);
});
it("drops an expired page cursor but retains the original oldest boundary for an idempotent rescan", async () => {
  const store = setup(),
    expired = Object.assign(new Error("expired"), {
      data: { error: "invalid_cursor" },
    }),
    first = vi.fn(async ({ cursor }: { cursor: string | undefined }) => {
      if (cursor) throw expired;
      return { messages: [{ ts: "11.000000" }], next: "expired" };
    }),
    input = options(store, first);
  expect(await recoverSlackHistory(input)).toBe(false);
  let rescanned = false;
  const resumed = vi.fn(async () => {
    if (!rescanned) {
      rescanned = true;
      return { messages: [{ ts: "11.000000" }], next: "page-2" };
    }
    return { messages: [{ ts: "12.000000" }], next: undefined };
  });
  expect(await recoverSlackHistory({ ...input, fetch: resumed })).toBe(true);
  expect(resumed).toHaveBeenCalledWith({
    oldest: "10.000000",
    cursor: undefined,
  });
  expect(input.ingest).toHaveBeenCalledTimes(3);
});
it("fails closed on a repeated cursor without advancing the complete watermark", async () => {
  const store = setup(),
    fetch = vi.fn(async () => ({
      messages: [{ ts: "11.000000" }],
      next: "same",
    }));
  expect(await recoverSlackHistory(options(store, fetch))).toBe(false);
  expect(
    store.db
      .prepare("SELECT ts FROM slack_cursors WHERE agent_id='research' AND channel='C'")
      .get(),
  ).toBeUndefined();
  expect(fetch).toHaveBeenCalledTimes(2);
});
it("persists a generic complete-scan cursor and clears it only after exhaustion", async () => {
  const store = setup(),
    key = "slack_scan:test";
  let fail = true;
  const fetch = vi.fn(async (cursor: string | undefined) => {
    if (cursor === "3" && fail) {
      fail = false;
      throw new Error("offline");
    }
    const page = cursor ? Number(cursor) : 0;
    return { messages: [page], next: page < 6 ? String(page + 1) : undefined };
  });
  await expect(scanSlackPages({ store, key, fetch, visit: () => false })).rejects.toThrow(
    "offline",
  );
  expect(
    JSON.parse(
      (store.db.prepare("SELECT value FROM runtime_meta WHERE key=?").get(key) as { value: string })
        .value,
    ),
  ).toMatchObject({ cursor: "3" });
  expect(
    await scanSlackPages({
      store,
      key,
      fetch,
      visit: (messages) => messages[0] === 6,
    }),
  ).toBe("found");
  expect(fetch.mock.calls.at(-1)?.[0]).toBe("6");
  expect(store.db.prepare("SELECT value FROM runtime_meta WHERE key=?").get(key)).toBeUndefined();
});
it("bounds an invalid-cursor rescan instead of looping forever on a broken page", async () => {
  const store = setup(),
    expired = Object.assign(new Error("expired"), {
      data: { error: "invalid_cursor" },
    });
  const fetch = vi.fn(async (cursor: string | undefined) => {
    if (cursor) throw expired;
    return { messages: [], next: "expired" };
  });
  await expect(
    scanSlackPages({
      store,
      key: "slack_scan:expired",
      fetch,
      visit: () => false,
    }),
  ).rejects.toThrow("expired");
  expect(fetch).toHaveBeenCalledTimes(4);
});
it("pauses a reconciliation scan after its page budget and resumes durably", async () => {
  const store = setup(),
    key = "slack_scan:budget",
    fetch = vi.fn(async (cursor: string | undefined) => {
      const page = cursor ? Number(cursor) : 0;
      return {
        messages: [page],
        next: page < 4 ? String(page + 1) : undefined,
      };
    });
  expect(
    await scanSlackPages({
      store,
      key,
      maxPages: 2,
      fetch,
      visit: () => false,
    }),
  ).toBe("paused");
  expect(
    await scanSlackPages({
      store,
      key,
      maxPages: 2,
      fetch,
      visit: () => false,
    }),
  ).toBe("paused");
  expect(
    await scanSlackPages({
      store,
      key,
      maxPages: 2,
      fetch,
      visit: () => false,
    }),
  ).toBe("exhausted");
  expect(fetch.mock.calls.map((call) => call[0])).toEqual([undefined, "1", "2", "3", "4"]);
});
