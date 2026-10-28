import { createParser } from "eventsource-parser";

/** A request with this login's cookies. A body is sent as JSON; GET sends none. */
export function sendJson(
  fetcher: typeof fetch,
  url: string,
  { method, body, signal }: { method: string; body?: unknown; signal: AbortSignal },
): Promise<Response> {
  return fetcher(url, {
    method,
    credentials: "include",
    signal,
    ...(method === "GET"
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }),
  });
}

/**
 * Reads server-sent events until `onEvent` returns true, and rejects when the stream ends first. `beforeRead` runs
 * before each chunk is awaited, so a caller can restart its heartbeat deadline.
 */
export async function readEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: string | undefined, data: string) => boolean | void,
  beforeRead: () => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let stopped = false;
  const parser = createParser({
    onEvent: ({ event, data }) => {
      if (!stopped && onEvent(event, data)) stopped = true;
    },
  });
  try {
    for (;;) {
      beforeRead();
      const { done, value } = await reader.read();
      if (done) throw new Error("Event stream disconnected");
      parser.feed(decoder.decode(value, { stream: true }));
      if (stopped) return;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
