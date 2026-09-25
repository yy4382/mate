import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { resolve } from "node:path";
import { OWNER_SESSION_COOKIE, OwnerAuth } from "./owner-auth.js";

export interface ControlPlaneAppOptions {
  webRoot?: string;
  dataDir?: string;
  passwordFile?: string;
  now?: () => number;
  sessionTtlMs?: number;
}

export class ControlPlaneApp extends Hono {
  constructor(private readonly ownerAuth: OwnerAuth) {
    super();
  }

  close(): void {
    this.ownerAuth.close();
  }
}

/** The public status contract deliberately contains no deployment or Agent details. */
export function createControlPlaneApp(options: ControlPlaneAppOptions = {}): ControlPlaneApp {
  const dataDir =
      options.dataDir ??
      process.env.MATE_CONTROL_PLANE_DATA_DIR ??
      resolve(process.cwd(), "data", "control-plane"),
    passwordFile = options.passwordFile ?? process.env.MATE_OWNER_PASSWORD_FILE,
    ownerAuth = new OwnerAuth({
      dataDir,
      ...(passwordFile !== undefined ? { passwordFile } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.sessionTtlMs !== undefined ? { sessionTtlMs: options.sessionTtlMs } : {}),
    }),
    app = new ControlPlaneApp(ownerAuth);

  const requireOwnerApi: MiddlewareHandler = async (context, next) => {
    const token = sessionToken(context);
    if (!token || !ownerAuth.hasSession(token))
      return context.json({ error: "请先登录", loginUrl: "/login" }, 401);
    await next();
  };
  const requireOwnerPage: MiddlewareHandler = async (context, next) => {
    const token = sessionToken(context);
    if (!token || !ownerAuth.hasSession(token)) return context.redirect("/login", 302);
    await next();
  };

  app.get("/api/status", (context) => context.json({ status: "running" as const }));

  app.post("/api/auth/login", async (context) => {
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: "请输入密码" }, 400);
    }
    const password =
      typeof body === "object" && body !== null && "password" in body
        ? (body as { password?: unknown }).password
        : undefined;
    if (typeof password !== "string" || !password || Buffer.byteLength(password, "utf8") > 1024)
      return context.json({ error: "请输入密码" }, 400);

    let result: "unconfigured" | "valid" | "invalid";
    try {
      result = await ownerAuth.verifyPassword(password);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown failure";
      process.stderr.write(`Owner password initialization failed: ${detail}\n`);
      return context.json(
        { error: "所有者密码文件不可用，请检查 MATE_OWNER_PASSWORD_FILE 和文件权限。" },
        503,
      );
    }
    if (result === "unconfigured")
      return context.json(
        { error: "尚未配置所有者密码，请部署者设置 MATE_OWNER_PASSWORD_FILE。" },
        503,
      );
    if (result === "invalid") return context.json({ error: "密码错误" }, 401);

    const session = ownerAuth.createSession();
    context.header("Set-Cookie", makeSessionCookie(session.token, session.maxAgeSeconds));
    return context.body(null, 204);
  });

  app.post("/api/auth/logout", (context) => {
    const token = sessionToken(context);
    if (token) ownerAuth.revokeSession(token);
    context.header("Set-Cookie", clearSessionCookie());
    return context.body(null, 204);
  });

  app.use("/api/owner/*", requireOwnerApi);
  app.get("/api/owner/session", (context) => context.json({ authenticated: true }));

  app.use("/app", requireOwnerPage);
  app.use("/app/*", requireOwnerPage);

  const webRoot = options.webRoot;
  if (webRoot) {
    const index = serveStatic({ root: webRoot, path: "index.html" });
    app.get("/", index);
    app.get("/login", index);
    app.get("/login/*", index);
    app.get("/app", index);
    app.get("/app/*", index);
    app.get("/assets/*", serveStatic({ root: webRoot }));
  }

  return app;
}

function sessionToken(context: Context): string | undefined {
  const header = context.req.header("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== OWNER_SESSION_COOKIE) continue;
    return part.slice(separator + 1).trim();
  }
  return undefined;
}

function makeSessionCookie(token: string, maxAgeSeconds: number): string {
  return `${OWNER_SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function clearSessionCookie(): string {
  return `${OWNER_SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}
