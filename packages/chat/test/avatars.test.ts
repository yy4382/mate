import { readFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { PNG } from "pngjs";
import { storeFixture, temporaryDirectory } from "@mate/testkit";
import { describe, expect, it } from "vitest";
import { ChatApp } from "../src/index.ts";
import { newAppWithOwner, refusalReason } from "./support.ts";

const red = readFileSync(new URL("../../../tests/fixtures/avatars/red.png", import.meta.url));
const blue = readFileSync(new URL("../../../tests/fixtures/avatars/blue.png", import.meta.url));
const request = (png: Buffer | null, requestId = "avatar") => ({
  requestId,
  png: png?.toString("base64") ?? null,
});

function chunk(type: string, bytes: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(bytes.length);
  header.write(type, 4);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), bytes])));
  return Buffer.concat([header, bytes, checksum]);
}

describe("account avatars through ChatApp", () => {
  it("stores a picture, publishes its account change, and replaying an old request never restores an old picture", () => {
    const { app, ownerId } = newAppWithOwner();
    const before = app.liveSnapshot(ownerId);
    expect(
      before.accounts.find((account) => account.accountId === ownerId)?.avatarVersion,
    ).toBeNull();
    let signals = 0;
    const unwatch = app.watchLive(() => signals++);
    const first = app.setAccountAvatar(ownerId, request(red));
    expect(first.avatarVersion).toMatch(/^[a-f0-9]{64}$/);
    const picture = app.accountAvatar(ownerId)!;
    const decoded = PNG.sync.read(Buffer.from(picture.png));
    expect([decoded.width, decoded.height, ...decoded.data.subarray(0, 4)]).toEqual([
      3, 2, 220, 40, 40, 255,
    ]);
    const events = app.liveEvents(ownerId, before.cursor);
    expect(events.status).toBe("events");
    if (events.status === "events")
      expect(events.events).toEqual([expect.objectContaining({ type: "account", account: first })]);
    expect(signals).toBe(1);
    expect(app.setAccountAvatar(ownerId, request(red))).toEqual(first);
    app.setAccountAvatar(ownerId, request(red, "same-pixels"));
    expect(signals, "identical images produce no account changes").toBe(1);
    const second = app.setAccountAvatar(ownerId, request(blue, "replace"));
    expect(second.avatarVersion).not.toBe(first.avatarVersion);
    expect(app.setAccountAvatar(ownerId, request(red))).toEqual(first);
    expect(app.accountAvatar(ownerId)?.version).toBe(second.avatarVersion);
    expect(refusalReason(() => app.setAccountAvatar(ownerId, request(blue)))).toBe(
      "request-conflict",
    );
    app.setAccountAvatar(ownerId, request(null, "remove"));
    expect(app.accountAvatar(ownerId)).toBeUndefined();
    expect(
      app.listAccounts().find((account) => account.accountId === ownerId)?.avatarVersion,
    ).toBeNull();
    expect(signals).toBe(3);
    unwatch();
    app.close();
  });

  it("preserves human and Agent pictures across reopen and names changing, including deactivated accounts' history", () => {
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
    const first = app.setAccountAvatar(human, request(red));
    const second = app.setAccountAvatar(agent, request(blue));
    app.ensureAccount({ externalId: "a", displayName: "Renamed", handle: "agent", kind: "agent" });
    app.close();
    app = new ChatApp(file);
    expect(app.accountAvatar(human)?.version).toBe(first.avatarVersion);
    expect(app.accountAvatar(agent)?.version).toBe(second.avatarVersion);
    app.deactivateAccount(agent, { requestId: "deactivate" });
    expect(app.accountAvatar(agent)?.version).toBe(second.avatarVersion);
    expect(refusalReason(() => app.setAccountAvatar(agent, request(red, "inactive")))).toBe(
      "inactive-account",
    );
    expect(refusalReason(() => app.setAccountAvatar(999999, request(red)))).toBe("unknown-account");
    app.close();
  });

  it("rejects invalid images without changing the old picture or publishing an account change", () => {
    const { app, ownerId } = newAppWithOwner();
    const original = app.setAccountAvatar(ownerId, request(red));
    const header = red.subarray(16, 29);
    const huge = Buffer.from(header);
    huge.writeUInt32BE(1000000, 0);
    const interlaced = Buffer.from(header);
    interlaced[12] = 1;
    const badCrc = Buffer.from(red);
    badCrc[badCrc.length - 1] = 0;
    const inputs = [
      Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"),
      red.subarray(0, 28),
      red.subarray(0, red.length - 1),
      badCrc,
      Buffer.concat([red, Buffer.from("trailing")]),
      Buffer.concat([red.subarray(0, 33), red.subarray(8)]),
      Buffer.concat([red.subarray(0, 8), chunk("IHDR", huge), red.subarray(33)]),
      Buffer.concat([red.subarray(0, 8), chunk("IHDR", interlaced), red.subarray(33)]),
      Buffer.concat([
        red.subarray(0, 33),
        chunk("IDAT", deflateSync(Buffer.alloc(1000000))),
        chunk("IEND", Buffer.alloc(0)),
      ]),
      Buffer.alloc(321 * 1024),
    ];
    const before = app.liveSnapshot(ownerId);
    for (const [index, input] of inputs.entries())
      expect(
        refusalReason(() => app.setAccountAvatar(ownerId, request(input, `bad-${index}`))),
      ).toBe("invalid-input");
    expect(
      refusalReason(() =>
        app.setAccountAvatar(ownerId, { requestId: "bad-base64", png: "not base64" }),
      ),
    ).toBe("invalid-input");
    expect(app.accountAvatar(ownerId)?.version).toBe(original.avatarVersion);
    const events = app.liveEvents(ownerId, before.cursor);
    if (events.status === "events") expect(events.events).toEqual([]);
    else throw new Error("cursor lost after rejected writes");
    app.close();
  });

  it("accepts browser color metadata but removes it from the persisted picture", () => {
    const { app, ownerId } = newAppWithOwner();
    const plain = app.setAccountAvatar(ownerId, request(red));
    const annotated = Buffer.concat([
      red.subarray(0, 33),
      chunk("sRGB", Buffer.from([0])),
      chunk("tEXt", Buffer.from("Comment\0private metadata")),
      red.subarray(33),
    ]);
    expect(app.setAccountAvatar(ownerId, request(annotated, "metadata")).avatarVersion).toBe(
      plain.avatarVersion,
    );
    expect(
      Buffer.from(app.accountAvatar(ownerId)!.png).includes(Buffer.from("private metadata")),
    ).toBe(false);
    app.close();
  });

  it("opens a released store with default avatars and persists new pictures without changing its accounts or messages", () => {
    const { dataDirectory, facts } = storeFixture("v0.1.0-alpha.2");
    const file = join(dataDirectory, "chat.sqlite");
    let app = new ChatApp(file);
    const human = app.findAccount("owner")!;
    const agent = app.findAccount(facts.agentExternalIds[0]!)!;
    const before = app.liveSnapshot(human);
    expect(before.accounts.every((account) => account.avatarVersion === null)).toBe(true);
    const general = before.conversations.find((conversation) => conversation.name === "general")!;
    const history = app.readHistory(human, { conversation: general.conversationId });
    const avatar = app.setAccountAvatar(agent, request(red));
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
