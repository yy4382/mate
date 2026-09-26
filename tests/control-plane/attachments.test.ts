import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createControlPlaneApp, type ControlPlaneApp } from "../../src/control-plane/http.js";

const password = "attachment-test-owner-password";
const fixtures: Array<{
  app: ControlPlaneApp;
  directory: string;
  passwordFile: string;
}> = [];

afterEach(() => {
  for (const { app, directory } of fixtures.splice(0)) {
    app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

async function setup() {
  const directory = mkdtempSync(join(tmpdir(), "mate-attachments-"));
  chmodSync(directory, 0o700);
  const passwordFile = join(directory, "owner-password");
  writeFileSync(passwordFile, `${password}\n`, { mode: 0o600 });
  const app = createControlPlaneApp({ dataDir: join(directory, "control-plane"), passwordFile });
  fixtures.push({ app, directory, passwordFile });
  const login = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    }),
    cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!,
    channel = app.chat.createChannel({ name: "附件测试", description: "", visibility: "private" });
  return { app, cookie, directory, passwordFile, channel };
}

function chunkedBody(chunks: string[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk === undefined) controller.close();
      else controller.enqueue(new TextEncoder().encode(chunk));
    },
  });
}

it("streams a Unicode owner upload into a channel and streams it back only through its channel", async () => {
  const { app, cookie, channel } = await setup(),
    filename = "共享资料.txt",
    upload = await app.request(`/api/owner/channels/${channel.id}/attachments`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "text/plain; charset=utf-8",
        "x-mate-filename": encodeURIComponent(filename),
      },
      body: chunkedBody(["第一", "段\n第二", "段"]),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
  expect(upload.status).toBe(201);
  const created = (await upload.json()) as {
    attachment: { id: string; filename: string; size: number };
  };
  expect(created.attachment).toMatchObject({ filename, size: Buffer.byteLength("第一段\n第二段") });

  const listing = await app.request(`/api/owner/channels/${channel.id}/attachments`, {
    headers: { cookie },
  });
  expect(listing.status).toBe(200);
  expect(await listing.json()).toMatchObject({
    attachments: [{ id: created.attachment.id, filename }],
  });

  const response = await app.request(
    `/api/owner/channels/${channel.id}/attachments/${created.attachment.id}/content`,
    { headers: { cookie } },
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("content-length")).toBe(String(created.attachment.size));
  expect(response.headers.get("x-accel-buffering")).toBe("no");
  const reader = response.body!.getReader(),
    parts: Uint8Array[] = [];
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    parts.push(item.value);
  }
  expect(Buffer.concat(parts).toString()).toBe("第一段\n第二段");

  const anotherChannel = app.chat.createChannel({
    name: "另一个对话",
    description: "",
    visibility: "private",
  });
  const wrongChannel = await app.request(
    `/api/owner/channels/${anotherChannel.id}/attachments/${created.attachment.id}/content`,
    { headers: { cookie } },
  );
  expect(wrongChannel.status).toBe(404);
});

it("removes an interrupted upload and does not expose partial attachment metadata", async () => {
  const { app, cookie, channel, directory } = await setup();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined,
    pulls = 0,
    signalFirstChunk!: () => void;
  const firstChunk = new Promise<void>((resolve) => (signalFirstChunk = resolve)),
    body = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
      },
      pull(streamController) {
        pulls++;
        if (pulls === 1) {
          streamController.enqueue(new Uint8Array(64 * 1024));
          signalFirstChunk();
          return;
        }
        return new Promise<void>(() => {});
      },
    }),
    pendingResponse = app.request(`/api/owner/channels/${channel.id}/attachments`, {
      method: "POST",
      headers: { cookie, "x-mate-filename": "interrupted.txt" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
  await firstChunk;
  controller!.error(new Error("network interrupted"));
  const response = await pendingResponse;
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ code: "upload_failed" });
  expect(pulls).toBeLessThanOrEqual(2);

  const database = new Database(join(directory, "control-plane", "control-plane.sqlite"));
  expect(
    database.prepare("SELECT count(*) AS count FROM owner_conversation_attachments").get(),
  ).toEqual({ count: 0 });
  database.close();
  expect(
    await (
      await app.request(`/api/owner/channels/${channel.id}/attachments`, { headers: { cookie } })
    ).json(),
  ).toEqual({ attachments: [] });
  expect(
    (await app.request(`/api/owner/channels/${channel.id}/attachments`, { headers: { cookie } }))
      .status,
  ).toBe(200);
});

it("cleans uploading rows and files left by a control-plane restart", async () => {
  const { app, directory, passwordFile, channel } = await setup(),
    dataDirectory = join(directory, "control-plane"),
    storageKey = randomUUID(),
    attachmentId = randomUUID(),
    database = new Database(join(dataDirectory, "control-plane.sqlite"));
  database
    .prepare(
      `INSERT INTO owner_conversation_attachments(
        id,channel_id,storage_key,filename,content_type,size,sha256,uploader_kind,uploader_id,state,created_at
      ) VALUES(?,?,?,?,?,0,?,'human','owner','uploading',?)`,
    )
    .run(
      attachmentId,
      channel.id,
      storageKey,
      "half-written.txt",
      "text/plain",
      "0".repeat(64),
      Date.now(),
    );
  writeFileSync(join(dataDirectory, "attachments", `${storageKey}.uploading`), "partial");
  writeFileSync(
    join(dataDirectory, "attachments", `${storageKey}.blob`),
    "renamed but uncommitted",
  );
  database.close();
  app.close();
  const previousFixture = fixtures.findIndex((fixture) => fixture.app === app);
  if (previousFixture >= 0) fixtures.splice(previousFixture, 1);

  const restarted = createControlPlaneApp({ dataDir: dataDirectory, passwordFile });
  fixtures.push({ app: restarted, directory, passwordFile });
  const login = await restarted.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    }),
    cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!,
    listing = await restarted.request(`/api/owner/channels/${channel.id}/attachments`, {
      headers: { cookie },
    });
  expect(listing.status).toBe(200);
  expect(await listing.json()).toEqual({ attachments: [] });
  expect(existsSync(join(dataDirectory, "attachments", `${storageKey}.uploading`))).toBe(false);
  expect(existsSync(join(dataDirectory, "attachments", `${storageKey}.blob`))).toBe(false);
});
