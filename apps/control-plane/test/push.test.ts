import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createSecureServer, type IncomingHttpHeaders, type ServerHttp2Session } from "node:http2";
import { join } from "node:path";
import { request } from "node:http";
import { FakeClock, HumanBrowser, temporaryDirectory } from "@mate/testkit";
import { expect, it, onTestFinished } from "vitest";
import { startControlPlane } from "../src/control-plane.ts";

const password = "disposable notification fixture password";
const server = "https://mate.example.com";
const native = {
  transport: "apns",
  token: "ab".repeat(32),
  environment: "sandbox",
  binding: randomUUID(),
} as const;

it("refuses unusable APNs credentials before serving and can restart with native push disabled", async () => {
  const directory = temporaryDirectory();
  const initialPasswordFile = join(directory, "password");
  writeFileSync(initialPasswordFile, password);
  const options = { dataDirectory: join(directory, "data"), initialPasswordFile };
  await expect(
    startControlPlane({
      ...options,
      apns: {
        keyFile: join(directory, "missing-test-key.p8"),
        keyId: "TESTKEY001",
        teamId: "TESTTEAM01",
        topic: "com.yy4382.mate",
        environment: "sandbox",
        server,
      },
    }),
  ).rejects.toThrow();
  const plane = await startControlPlane(options);
  onTestFinished(() => plane.close());
  const owner = new HumanBrowser(plane.url);
  await owner.logIn("admin", password);
  expect((await owner.get("/api/chat/push/native")).json).toEqual({ enabled: false });
});

/** A TLS APNs protocol fixture, reached through the real provider library. No Apple endpoints are used. */
async function fixture(configured = true) {
  const directory = temporaryDirectory();
  const certFile = join(directory, "cert.pem"),
    tlsKey = join(directory, "tls.pem"),
    apnsKey = join(directory, "apns.p8");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
      "-keyout",
      tlsKey,
      "-out",
      certFile,
    ],
    { stdio: "ignore" },
  );
  const { privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
  writeFileSync(apnsKey, privateKey);
  const cert = readFileSync(certFile);
  const remote = createSecureServer({ cert, key: readFileSync(tlsKey) });
  const sessions = new Set<ServerHttp2Session>();
  remote.on("session", (session) => {
    sessions.add(session);
    session.on("close", () => sessions.delete(session));
  });
  const requests: { headers: IncomingHttpHeaders; body: string }[] = [];
  const answers: { status: number; reason?: string }[] = [];
  remote.on("stream", (stream, headers) => {
    let body = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => (body += chunk));
    stream.on("end", () => {
      requests.push({ headers, body });
      const answer = answers.shift() ?? { status: 200 };
      if (answer.status === 0) {
        stream.session?.destroy();
        return;
      }
      stream.respond({ ":status": answer.status });
      stream.end(answer.reason ? JSON.stringify({ reason: answer.reason }) : "");
    });
  });
  await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve));
  const address = remote.address();
  if (!address || typeof address === "string") throw new Error("APNs fixture has no port");
  const clock = new FakeClock(Date.UTC(2026, 9, 26));
  const initialPasswordFile = join(directory, "password");
  writeFileSync(initialPasswordFile, password);
  const plane = await startControlPlane({
    dataDirectory: join(directory, "data"),
    initialPasswordFile,
    clock,
    ...(configured
      ? {
          apns: {
            keyFile: apnsKey,
            keyId: "TESTKEY001",
            teamId: "TESTTEAM01",
            topic: "com.yy4382.mate",
            environment: "sandbox",
            server,
            connection: { address: "localhost", port: address.port, ca: [cert] },
          },
        }
      : {}),
  });
  onTestFinished(async () => {
    await plane.close();
    for (const session of sessions) session.destroy();
    await new Promise<void>((resolve) => remote.close(() => resolve()));
  });
  const owner = new HumanBrowser(plane.url);
  await owner.logIn("admin", password);
  const ownerId = (await owner.get("/api/me")).json as { accountId: number };
  await owner.post("/api/humans", {
    requestId: "member",
    handle: "sam",
    displayName: "Sam",
    password,
    role: "member",
  });
  const member = new HumanBrowser(plane.url);
  await member.logIn("sam", password);
  const memberId = (await member.get("/api/me")).json as { accountId: number };
  const dm = (await member.post("/api/chat/dms", { requestId: "dm", other: ownerId.accountId }))
    .json as { conversationId: number };
  const say = (requestId: string = randomUUID()) =>
    member.post("/api/chat/messages", {
      requestId,
      timeline: { conversation: dm.conversationId },
      body: "the private message body",
    });
  return {
    plane,
    clock,
    requests,
    answers,
    owner,
    member,
    ownerId: ownerId.accountId,
    memberId: memberId.accountId,
    dm,
    say,
  };
}

it.each(["logout", "replacement"])(
  "a cancelled native binding cannot return when its HTTP body finishes after %s",
  async (mode) => {
    const f = await fixture();
    const subscription = { ...native, binding: randomUUID() };
    const body = JSON.stringify(subscription);
    const cookie = f.owner.cookie;
    if (!cookie) throw new Error("fixture login has no cookie");
    const status = await new Promise<number>((resolve, reject) => {
      const pending = request(
        f.plane.url + "/api/chat/push/subscribe",
        {
          method: "POST",
          headers: {
            cookie,
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
            expect: "100-continue",
          },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode ?? 0));
        },
      );
      pending.on("error", reject);
      pending.on("continue", () => {
        void (async () => {
          pending.write(body.slice(0, -1));
          expect((await f.owner.post("/api/chat/push/unsubscribe", subscription)).status).toBe(204);
          if (mode === "logout") expect((await f.owner.post("/api/logout", {})).status).toBe(204);
          else
            expect(
              (
                await f.member.post("/api/chat/push/subscribe", {
                  ...subscription,
                  binding: randomUUID(),
                })
              ).status,
            ).toBe(204);
          pending.end(body.slice(-1));
        })().catch((error: unknown) => {
          pending.destroy();
          reject(error);
        });
      });
      pending.flushHeaders();
    });
    expect(status).toBe(400);
    await f.say();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.requests, "new notices cannot reach the cancelled old account registration").toEqual(
      [],
    );
    if (mode === "replacement") {
      const sent = await f.owner.post("/api/chat/messages", {
        requestId: randomUUID(),
        timeline: { conversation: f.dm.conversationId },
        body: "fixture for the new owner",
      });
      expect(sent.status).toBe(200);
      await expect.poll(() => f.requests.length).toBe(1);
      expect(JSON.parse(f.requests[0]?.body ?? "null").body.accountId).toBe(f.memberId);
    }
  },
);

it("reports disabled APNs truthfully while retaining the existing Web Push subscription API", async () => {
  const f = await fixture(false);
  expect((await new HumanBrowser(f.plane.url).get("/api/chat/push/native")).status).toBe(401);
  expect((await f.owner.get("/api/chat/push/native")).json).toEqual({ enabled: false });
  expect((await f.owner.post("/api/chat/push/subscribe", native)).status).toBe(503);
  expect(
    (
      await f.owner.post("/api/chat/push/subscribe", {
        endpoint: "https://push.example/device",
        keys: { p256dh: "key", auth: "auth" },
      })
    ).status,
  ).toBe(204);
  expect((await f.owner.get("/api/chat/push/key")).json).toHaveProperty("publicKey");
});

it("validates native transport data and sends a private, scoped alert through the real APNs library", async () => {
  const f = await fixture();
  for (const subscription of [
    { ...native, token: "https://not-a-token" },
    { ...native, token: "abc" },
    { ...native, environment: "other" },
    { ...native, binding: "invalid" },
    { ...native, transport: "fcm" },
  ])
    expect((await f.owner.post("/api/chat/push/subscribe", subscription)).status).toBe(400);
  expect(
    (await f.owner.post("/api/chat/push/subscribe", { ...native, environment: "production" }))
      .status,
  ).toBe(409);
  expect(
    (await f.owner.post("/api/chat/push/subscribe", { ...native, accountId: f.memberId })).status,
  ).toBe(204);
  await f.say("once");
  await f.say("once");
  await expect.poll(() => f.requests.length).toBe(1);
  const request = f.requests[0]!;
  expect(request.headers).toMatchObject({
    ":path": `/3/device/${native.token}`,
    "apns-topic": "com.yy4382.mate",
    "apns-push-type": "alert",
    "apns-priority": "10",
    "apns-expiration": String((f.clock.now() + 86_400_000) / 1000),
  });
  expect(request.headers.authorization).toMatch(/^bearer /);
  expect(request.body).not.toContain("private message body");
  expect(JSON.parse(request.body)).toMatchObject({
    aps: { alert: { title: "Mate", body: "你有新的私信或提及。" } },
    body: {
      version: 1,
      server,
      accountId: f.ownerId,
      binding: native.binding,
      conversationId: f.dm.conversationId,
      threadId: null,
      seq: 1,
    },
  });
});

it("only lets a human unsubscribe their own native binding and drops old queued deliveries when the token changes owner", async () => {
  const f = await fixture();
  await f.owner.post("/api/chat/push/subscribe", native);
  await f.member.post("/api/chat/push/unsubscribe", native);
  f.answers.push({ status: 503 });
  await f.say();
  await expect.poll(() => f.requests.length).toBe(1);
  await f.member.post("/api/chat/push/subscribe", { ...native, binding: randomUUID() });
  f.clock.advance(30_000);
  // A new owner receives their own notice, never the queued notice for the old owner.
  await f.owner.post("/api/chat/messages", {
    requestId: randomUUID(),
    timeline: { conversation: f.dm.conversationId },
    body: "new owner",
  });
  await expect.poll(() => f.requests.length).toBe(2);
  expect(JSON.parse(f.requests[1]!.body).body.accountId).toBe(f.memberId);
});

it.each([
  [400, "BadDeviceToken", false],
  [410, "Unregistered", false],
  [400, "DeviceTokenNotForTopic", false],
  [404, "BadPath", true],
  [403, "InvalidProviderToken", true],
  [400, "PayloadEmpty", true],
])(
  "handles APNs %s %s without confusing provider errors with invalid device tokens",
  async (status, reason, remains) => {
    const f = await fixture();
    await f.owner.post("/api/chat/push/subscribe", native);
    f.answers.push({ status, reason });
    await f.say();
    await expect.poll(() => f.requests.length).toBe(1);
    // An HTTP request round trip lets the delivery's result settle before the next message.
    await f.owner.get("/api/chat/snapshot");
    await f.say();
    if (remains) await expect.poll(() => f.requests.length).toBe(2);
    else {
      f.clock.advance(86_400_000);
      await f.owner.get("/api/chat/snapshot");
      expect(f.requests).toHaveLength(1);
    }
  },
);

it.each([
  { status: 0 },
  { status: 429 },
  { status: 500 },
  { status: 503 },
  { status: 403, reason: "ExpiredProviderToken" },
])(
  "retries APNs %s through the shared durable queue with a stable collapse ID and expiry",
  async (answer) => {
    const f = await fixture();
    await f.owner.post("/api/chat/push/subscribe", native);
    f.answers.push(answer);
    await f.say();
    await expect.poll(() => f.requests.length).toBe(1);
    await f.owner.get("/api/chat/snapshot");
    f.clock.advance(30_000);
    await expect.poll(() => f.requests.length).toBe(2);
    expect(f.requests[1]!.headers["apns-collapse-id"]).toBe(
      f.requests[0]!.headers["apns-collapse-id"],
    );
    expect(f.requests[1]!.headers["apns-expiration"]).toBe(
      f.requests[0]!.headers["apns-expiration"],
    );
  },
);

it("does not hand notices older than a day to APNs after a delayed retry", async () => {
  const f = await fixture();
  await f.owner.post("/api/chat/push/subscribe", native);
  f.answers.push({ status: 503 });
  await f.say();
  await expect.poll(() => f.requests.length).toBe(1);
  await f.owner.get("/api/chat/snapshot");
  f.clock.advance(86_400_001);
  await f.say();
  await expect.poll(() => f.requests.length).toBe(2);
  expect(JSON.parse(f.requests[1]!.body).body.seq).toBe(2);
});
