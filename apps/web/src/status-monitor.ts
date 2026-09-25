export type ServiceState = "loading" | "running" | "unavailable";

const STATUS_CHECK_INTERVAL_MS = 10_000;
const STATUS_REQUEST_TIMEOUT_MS = 5_000;

function isRunningStatus(value: unknown): value is { status: "running" } {
  return (
    typeof value === "object" && value !== null && "status" in value && value.status === "running"
  );
}

export function watchServiceStatus(
  update: (state: Exclude<ServiceState, "loading">) => void,
  requestStatus: typeof fetch = fetch,
  intervalMs = STATUS_CHECK_INTERVAL_MS,
  requestTimeoutMs = STATUS_REQUEST_TIMEOUT_MS,
): () => void {
  let active = true;
  let nextCheck: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();

  const check = async () => {
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(requestTimeoutMs)]);
      const response = await requestStatus("/api/status", {
        signal,
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error("Status request failed");
      const body: unknown = await response.json();
      if (!isRunningStatus(body)) throw new Error("Unexpected status response");
      if (active) update("running");
    } catch {
      if (active) update("unavailable");
    } finally {
      if (active) nextCheck = setTimeout(() => void check(), intervalMs);
    }
  };

  void check();
  return () => {
    active = false;
    controller.abort();
    if (nextCheck) clearTimeout(nextCheck);
  };
}
