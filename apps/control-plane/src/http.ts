import type { IncomingMessage, ServerResponse } from "node:http";
import { AdminError, AgentCreationFailed, type AdminErrorReason } from "@mate/admin";
import { ChatError, type ChatErrorReason } from "@mate/chat";

/** Request bodies are small JSON documents; the largest is a message of at most 20,000 characters. */
const MAX_BODY_BYTES = 1024 * 1024;

/** A refusal the shell answers itself, with a status and a stable `error` code the client branches on. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message = code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Every chat refusal reason has one HTTP status. */
const CHAT_STATUS: Record<ChatErrorReason, number> = {
  "invalid-input": 400,
  "invalid-target": 400,
  "unknown-account": 404,
  "not-found": 404,
  "inactive-account": 403,
  "not-member": 403,
  "owner-only": 403,
  archived: 409,
  "request-conflict": 409,
  "handle-taken": 409,
};

/** Every admin refusal reason has one HTTP status. */
const ADMIN_STATUS: Record<AdminErrorReason, number> = {
  "invalid-input": 400,
  "unknown-model": 400,
  "unsupported-thinking-level": 400,
  "unknown-agent": 404,
  "unknown-node": 404,
  "unknown-provider": 404,
  "unknown-assistant": 404,
  "no-credentials": 409,
  "agent-closed": 409,
  "not-found": 404,
  "outside-workspace": 403,
  unreadable: 422,
  "node-offline": 503,
};

/**
 * The response for a refusal: `{ error, message }`, plus `agentId` for a create that failed part way, which the client
 * sends back to finish it. Anything else is a fault of the control plane.
 */
export function refusal(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof HttpError)
    return { status: error.status, body: { error: error.code, message: error.message } };
  if (error instanceof ChatError)
    return {
      status: CHAT_STATUS[error.reason],
      body: { error: error.reason, message: error.message },
    };
  if (error instanceof AdminError)
    return {
      status: ADMIN_STATUS[error.reason],
      body: { error: error.reason, message: error.message },
    };
  if (error instanceof AgentCreationFailed)
    return {
      status: 500,
      body: { error: "creation-failed", message: error.message, agentId: error.agentId },
    };
  return { status: 500, body: { error: "internal", message: "internal error" } };
}

export function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  if (body === undefined) {
    response.writeHead(status === 200 ? 204 : status, headers).end();
    return;
  }
  response
    .writeHead(status, {
      ...headers,
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    })
    .end(JSON.stringify(body));
}

/** The request's JSON body, or undefined when it has none. */
export async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "body-too-large");
    chunks.push(chunk);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid-json");
  }
}

/** The value of cookie `name`, if the request carries it. */
export function cookie(request: IncomingMessage, name: string): string | undefined {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0 && part.slice(0, separator).trim() === name)
      return part.slice(separator + 1).trim();
  }
  return undefined;
}

/**
 * A JSON object the receiving module parses itself. The chat app and the admin module check every input against their
 * own schemas and refuse a mismatch with `invalid-input`, so the shell only makes sure it hands over an object.
 */
export function forwarded<T>(body: unknown): T {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw new HttpError(400, "invalid-input", "the body must be a JSON object");
  return body as T;
}
