export function jsonRequest(method: "POST" | "PUT" | "PATCH", body: unknown) {
  return {
    method,
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export function readResponseJSON(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

export function responseErrorMessage(result: unknown, fallback: string) {
  return typeof result === "object" && result !== null && "error" in result
    ? String(result.error)
    : fallback;
}
