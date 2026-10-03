import { conversationSchema } from "../../src/conversations/schema.js";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { join } from "node:path";

import { expect, it } from "vitest";
import { ownerAuthSchema } from "../../src/auth/schema.js";
import { ownerPassword } from "../support/node/connection-fixture.js";
import { ProcessOutput, stopProcess } from "../support/node/process-output.js";

it("refuses an old experimental database without modifying its saved owner chat", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mate-node-schema-upgrade-"));
  chmodSync(directory, 0o700);
  const dataDir = join(directory, "control-plane-data");
  mkdirSync(dataDir, { mode: 0o700 });
  const passwordFile = join(directory, "owner-password");
  writeFileSync(passwordFile, `${ownerPassword}\n`, { mode: 0o600 });
  const databasePath = join(dataDir, "control-plane.sqlite");
  const legacy = new Database(databasePath);
  legacy.exec(ownerAuthSchema + conversationSchema);
  legacy.pragma("application_id = 1296257100");
  legacy.pragma("user_version = 3");
  legacy
    .prepare(
      "INSERT INTO owner_channels(id,name,description,visibility,created_at,updated_at) VALUES('saved-channel','保存的频道','','public',10,10)",
    )
    .run();
  legacy
    .prepare(
      "INSERT INTO owner_channel_memberships(channel_id,principal_kind,principal_id,active,joined_at) VALUES('saved-channel','human','owner',1,10)",
    )
    .run();
  legacy
    .prepare(
      "INSERT INTO owner_messages(id,channel_id,order_seq,text,created_at) VALUES('saved-message','saved-channel',1,'升级前的持久消息',11)",
    )
    .run();
  legacy.close();

  const serverChild = spawn(process.execPath, [resolve("dist/main.js")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MATE_CONTROL_PLANE_PORT: "0",
      MATE_CONTROL_PLANE_DATA_DIR: dataDir,
      MATE_OWNER_PASSWORD_FILE: passwordFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const server = new ProcessOutput(serverChild);
  try {
    await expect(server.waitFor(/MATE_CONTROL_PLANE_LISTENING (\d+)/)).rejects.toThrow(
      "schema revision 3",
    );
    const saved = new Database(databasePath, { readonly: true });
    expect(saved.pragma("user_version", { simple: true })).toBe(3);
    expect(saved.prepare("SELECT text FROM owner_messages WHERE id='saved-message'").get()).toEqual(
      { text: "升级前的持久消息" },
    );
    expect(
      saved.prepare("SELECT name FROM sqlite_master WHERE name='nodes'").get(),
    ).toBeUndefined();
    saved.close();
  } finally {
    await stopProcess(server);
    rmSync(directory, { recursive: true, force: true });
  }
}, 15000);
