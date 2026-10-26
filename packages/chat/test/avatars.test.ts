import { readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { storeFixture, temporaryDirectory } from "@mate/testkit";
import { describe, expect, it } from "vitest";
import { ChatApp } from "../src/index.ts";
import { newAppWithOwner } from "./support.ts";

const red = readFileSync(new URL("../../../tests/fixtures/avatars/red.png", import.meta.url));
const blue = readFileSync(new URL("../../../tests/fixtures/avatars/blue.png", import.meta.url));
const request = (png: Buffer | null, requestId = "avatar") => ({
  requestId,
  png: png?.toString("base64") ?? null,
});

describe("account avatars through ChatApp", () => {
  it("stores a picture once for concurrent requests and replaying an old request never restores an old picture", async () => {
    const { app, ownerId } = newAppWithOwner();
    const before = app.liveSnapshot(ownerId);
    expect(
      before.accounts.find((account) => account.accountId === ownerId)?.avatarVersion,
    ).toBeNull();
    let signals = 0;
    const unwatch = app.watchLive(() => signals++);
    const [first, duplicate] = await Promise.all([
      app.setAccountAvatar(ownerId, request(red)),
      app.setAccountAvatar(ownerId, request(red)),
    ]);
    expect(duplicate).toEqual(first);
    expect(first.avatarVersion).toMatch(/^[a-f0-9]{64}$/);
    const picture = app.accountAvatar(ownerId)!;
    expect((await sharp(picture.webp).metadata()).format).toBe("webp");
    const decoded = await sharp(picture.webp)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect([decoded.info.width, decoded.info.height]).toEqual([3, 2]);
    expect(decoded.data[0]).toBeGreaterThan(200);
    expect(decoded.data[1]).toBeLessThan(60);
    expect(decoded.data[2]).toBeLessThan(60);
    expect(decoded.data[3]).toBe(255);
    const events = app.liveEvents(ownerId, before.cursor);
    expect(events.status).toBe("events");
    if (events.status === "events")
      expect(events.events).toEqual([expect.objectContaining({ type: "account", account: first })]);
    expect(signals).toBe(1);
    expect(await app.setAccountAvatar(ownerId, request(red))).toEqual(first);
    await app.setAccountAvatar(ownerId, request(red, "same-pixels"));
    expect(signals, "identical images produce no account changes").toBe(1);
    const second = await app.setAccountAvatar(ownerId, request(blue, "replace"));
    expect(second.avatarVersion).not.toBe(first.avatarVersion);
    expect(await app.setAccountAvatar(ownerId, request(red))).toEqual(first);
    expect(app.accountAvatar(ownerId)?.version).toBe(second.avatarVersion);
    await expect(app.setAccountAvatar(ownerId, request(blue))).rejects.toMatchObject({
      reason: "request-conflict",
    });
    await app.setAccountAvatar(ownerId, request(null, "remove"));
    expect(app.accountAvatar(ownerId)).toBeUndefined();
    expect(
      app.listAccounts().find((account) => account.accountId === ownerId)?.avatarVersion,
    ).toBeNull();
    expect(signals).toBe(3);
    unwatch();
    app.close();
  });

  it("preserves human and Agent pictures across reopen and names changing, including deactivated accounts' history", async () => {
    const file = join(temporaryDirectory(), "chat.sqlite");
    let app = new ChatApp(file);
    const human = app.ensureAccount({
      externalId: "h",
      displayName: "H",
      handle: "human",
      kind: "human",
    });
    const agent = app.ensureAccount({
      externalId: "a",
      displayName: "A",
      handle: "agent",
      kind: "agent",
    });
    const first = await app.setAccountAvatar(human, request(red));
    const second = await app.setAccountAvatar(agent, request(blue));
    app.ensureAccount({ externalId: "a", displayName: "Renamed", handle: "agent", kind: "agent" });
    app.close();
    app = new ChatApp(file);
    expect(app.accountAvatar(human)?.version).toBe(first.avatarVersion);
    expect(app.accountAvatar(agent)?.version).toBe(second.avatarVersion);
    const pending = app.setAccountAvatar(agent, request(red, "inactive"));
    app.deactivateAccount(agent, { requestId: "deactivate" });
    await expect(pending).rejects.toMatchObject({ reason: "inactive-account" });
    expect(app.accountAvatar(agent)?.version).toBe(second.avatarVersion);
    expect(await app.setAccountAvatar(agent, request(blue))).toEqual(second);
    await expect(app.setAccountAvatar(999999, request(red))).rejects.toMatchObject({
      reason: "unknown-account",
    });
    app.close();
  });

  it("rejects invalid images without changing the old picture or publishing an account change", async () => {
    const { app, ownerId } = newAppWithOwner();
    const original = await app.setAccountAvatar(ownerId, request(red));
    const wide = await sharp({ create: { width: 257, height: 1, channels: 3, background: "red" } })
      .png()
      .toBuffer();
    const tall = await sharp({ create: { width: 1, height: 257, channels: 3, background: "red" } })
      .png()
      .toBuffer();
    const oversized = await sharp({
      create: { width: 257, height: 257, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    const inputs = [
      Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"),
      red.subarray(0, 28),
      await sharp(red).jpeg().toBuffer(),
      wide,
      tall,
      oversized,
      Buffer.alloc(321 * 1024),
    ];
    const before = app.liveSnapshot(ownerId);
    for (const [index, input] of inputs.entries())
      await expect(
        app.setAccountAvatar(ownerId, request(input, `bad-${index}`)),
      ).rejects.toMatchObject({ reason: "invalid-input" });
    await expect(
      app.setAccountAvatar(ownerId, { requestId: "bad-base64", png: "not base64" }),
    ).rejects.toMatchObject({ reason: "invalid-input" });
    expect(app.accountAvatar(ownerId)?.version).toBe(original.avatarVersion);
    const events = app.liveEvents(ownerId, before.cursor);
    if (events.status === "events") expect(events.events).toEqual([]);
    else throw new Error("cursor lost after rejected writes");
    app.close();
  });

  it("preserves transparency while removing uploaded metadata from the persisted WebP", async () => {
    const { app, ownerId } = newAppWithOwner();
    const annotated = await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 4,
        background: { r: 220, g: 40, b: 40, alpha: 0.5 },
      },
    })
      .withMetadata({ exif: { IFD0: { ImageDescription: "private metadata" } } })
      .png()
      .toBuffer();
    expect((await sharp(annotated).metadata()).exif).toBeDefined();
    await app.setAccountAvatar(ownerId, request(annotated));
    const persisted = app.accountAvatar(ownerId)!.webp;
    const metadata = await sharp(persisted).metadata();
    expect(metadata.format).toBe("webp");
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
    const decoded = await sharp(persisted).ensureAlpha().raw().toBuffer();
    expect(decoded[3]).toBe(128);
    app.close();
  });

  it("opens a released store with default avatars and persists new pictures without changing its accounts or messages", async () => {
    const { dataDirectory, facts } = storeFixture("v0.1.0-alpha.2");
    const file = join(dataDirectory, "chat.sqlite");
    let app = new ChatApp(file);
    const human = app.findAccount("owner")!;
    const agent = app.findAccount(facts.agentExternalIds[0]!)!;
    const before = app.liveSnapshot(human);
    expect(before.accounts.every((account) => account.avatarVersion === null)).toBe(true);
    const general = before.conversations.find((conversation) => conversation.name === "general")!;
    const history = app.readHistory(human, { conversation: general.conversationId });
    const avatar = await app.setAccountAvatar(agent, request(red));
    app.close();
    app = new ChatApp(file);
    expect(app.accountAvatar(agent)?.version).toBe(avatar.avatarVersion);
    expect(app.readHistory(human, { conversation: general.conversationId })).toEqual(history);
    expect(app.listAccounts().map(({ accountId, handle }) => [accountId, handle])).toEqual(
      before.accounts.map(({ accountId, handle }) => [accountId, handle]),
    );
    app.close();
  });
});
