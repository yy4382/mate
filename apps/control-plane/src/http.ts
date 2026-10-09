import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import type { OwnerAuth } from "./auth/service.js";
import { sessionToken, makeSessionCookie, clearSessionCookie } from "./auth/session-cookie.js";
import { LoginGate } from "./auth/login-gate.js";
import type { OwnerPush } from "./notifications/push.js";

export function createOwnerRoutes(ownerAuth: OwnerAuth, push: OwnerPush) {
  const loginGate = new LoginGate();
  const requireOwnerApi = createMiddleware(async (context, next) => {
    const token = sessionToken(context);
    if (!token || !ownerAuth.hasSession(token))
      return context.json({ error: "请先登录", loginUrl: "/login" }, 401);
    await next();
  });

  return new Hono()
    .get("/api/status", (context) => context.json({ status: "running" as const }))

    .post("/api/auth/login", async (context) => {
      let body: unknown;
      try {
        body = await context.req.json();
      } catch {
        return context.json({ error: "请输入密码" }, 400);
      }
      const password =
        typeof body === "object" && body !== null && "password" in body ? body.password : undefined;
      if (typeof password !== "string" || !password || Buffer.byteLength(password, "utf8") > 1024)
        return context.json({ error: "请输入密码" }, 400);

      let result: "unconfigured" | "valid" | "invalid";
      try {
        const outcome = await loginGate.run(() => ownerAuth.verifyPassword(password));
        if (outcome.kind === "limited") {
          context.header("Retry-After", String(outcome.retryAfterSeconds));
          const error = `已有登录请求正在验证，请在 ${outcome.retryAfterSeconds} 秒后重试。`;
          return context.json({ error, retryAfterSeconds: outcome.retryAfterSeconds }, 429);
        }
        result = outcome.result;
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
    })

    .post("/api/auth/logout", (context) => {
      const token = sessionToken(context);
      if (token) ownerAuth.revokeSession(token);
      context.header("Set-Cookie", clearSessionCookie());
      return context.body(null, 204);
    })

    .use("/api/owner/*", requireOwnerApi)
    .get("/api/owner/session", (context) => context.json({ authenticated: true }))
    .get("/api/owner/push/public-key", (context) => context.json({ publicKey: push.publicKey }))
    .post("/api/owner/push/subscriptions", async (context) => {
      const body: unknown = await context.req.json().catch(() => null);
      const input = z
        .object({ endpoint: z.string(), keys: z.object({ p256dh: z.string(), auth: z.string() }) })
        .safeParse(body);
      if (!input.success) return context.json({ error: "推送订阅无效" }, 400);
      try {
        push.subscribe(input.data);
      } catch {
        return context.json({ error: "推送订阅无效" }, 400);
      }
      return context.json({ subscribed: true }, 201);
    })
    .delete("/api/owner/push/subscriptions", async (context) => {
      const body: unknown = await context.req.json().catch(() => null);
      const endpoint = z.object({ endpoint: z.string().max(4096) }).safeParse(body);
      if (!endpoint.success) return context.json({ error: "推送订阅无效" }, 400);
      push.unsubscribe(endpoint.data.endpoint);
      return context.json({ subscribed: false });
    });
}

export function createWebPages(ownerAuth: Pick<OwnerAuth, "hasSession">, webRoot?: string) {
  const requireOwnerPage = createMiddleware(async (context, next) => {
    const token = sessionToken(context);
    if (!token || !ownerAuth.hasSession(token)) {
      const requestUrl = new URL(context.req.url);
      const nextPath = `${requestUrl.pathname}${requestUrl.search}`;
      return context.redirect(
        nextPath === "/app" ? "/login" : `/login?next=${encodeURIComponent(nextPath)}`,
        302,
      );
    }
    await next();
  });
  const pages = new Hono().use("/app", requireOwnerPage).use("/app/*", requireOwnerPage);
  if (!webRoot) return pages;

  const assets = serveStatic({ root: webRoot });
  const index = serveStatic({ root: webRoot, path: "index.html" });
  return pages
    .on("GET", ["/", "/login", "/login/*", "/app", "/app/*"], index)
    .on(
      "GET",
      [
        "/assets/*",
        "/manifest.webmanifest",
        "/sw.js",
        "/icon.svg",
        "/icon-192.png",
        "/icon-512.png",
      ],
      assets,
    );
}
