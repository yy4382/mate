import type { Context } from "hono";
import { OWNER_SESSION_COOKIE } from "./service.js";

export function sessionToken(context: Context): string | undefined {
  const header = context.req.header("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== OWNER_SESSION_COOKIE) continue;
    return part.slice(separator + 1).trim();
  }
  return undefined;
}

export function makeSessionCookie(token: string, maxAgeSeconds: number): string {
  return `${OWNER_SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function clearSessionCookie(): string {
  return `${OWNER_SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}
