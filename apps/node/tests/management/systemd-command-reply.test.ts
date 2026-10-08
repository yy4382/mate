import { expect, test } from "vitest";
import {
  readExecStartProperty,
  readPrivateProperty,
} from "../../src/management/service/systemd-property.js";
import { serviceReferencesBundle } from "../../src/management/service/unit.js";
import { nodePaths } from "../../src/management/paths.js";
import dbus, { Variant } from "dbus-native";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";

const runtime = '/test/${USER} % "quoted"\\mate/node/bin/node';
const record = (argv: string[]) => [runtime, argv, ["no-env-expand"], 0n, 0n, 0n, 0n, 0, 0, 0];

test("decoded binary command property retains literal values and each argv boundary", () => {
  const argv = [runtime, "/test/node entry.js", "--config-file", "/test/private config.json"];
  expect(readExecStartProperty(new Variant("a(sasasttttuii)", [record(argv)]))).toEqual([
    { path: runtime, argv, flags: ["no-env-expand"] },
  ]);
});

test("one argument containing typed-looking lines cannot impersonate several arguments", () => {
  const paths = nodePaths("/test");
  const runtime = `${paths.versionsDirectory}/0.1.0/node/bin/node`;
  const node = `${paths.versionsDirectory}/0.1.0/app/apps/node/dist/main.js`;
  const argv = [runtime, `${node}"\n string "--config-file"\n string "${paths.configuration}`];
  const commands = readExecStartProperty(
    new Variant("a(sasasttttuii)", [[runtime, argv, ["no-env-expand"], 0n, 0n, 0n, 0n, 0, 0, 0]]),
  );
  expect(commands[0]?.argv).toHaveLength(2);
  expect(
    serviceReferencesBundle(
      {
        load: "loaded",
        active: "inactive",
        sub: "dead",
        enabled: "disabled",
        pid: 0,
        job: 0,
        fragment: paths.unit,
        needsReload: false,
        type: "exec",
        execStart: commands,
      },
      paths,
      "0.1.0",
    ),
  ).toBe(false);
});

test("incorrect signatures, truncated structs and unknown decoded types fail closed", () => {
  for (const invalid of [
    new Variant("s", "not commands"),
    new Variant("a(sasasttttuii)", [[runtime, []]]),
    new Variant("a(sasasttttuii)", [record([runtime]), [runtime, [false]]]),
  ])
    expect(() => readExecStartProperty(invalid)).toThrow("unrecognized");
});

test("the peer adapter reads binary properties with no bus daemon or Hello and preserves multiline argv", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mate-private-property-"));
  const socket = join(directory, "peer");
  const argv = [runtime, 'node"\n string "--config-file"\n string "config'];
  const calls: string[] = [];
  const server = createServer((stream) => {
    const connection = dbus.createConnection({ stream, server: true, authMethods: ["EXTERNAL"] });
    connection.on("message", (message) => {
      calls.push(message.member ?? "unknown");
      if (message.member !== "Get" || !message.serial) {
        stream.destroy();
        return;
      }
      const value =
        message.body?.[1] === "Version"
          ? new Variant("s", "synthetic manager")
          : new Variant("a(sasasttttuii)", [record(argv)]);
      connection.message({
        type: dbus.messageType.methodReturn,
        serial: 1,
        replySerial: message.serial,
        signature: "v",
        body: [value],
      });
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, resolve);
    });
    expect(await readPrivateProperty("Version", socket)).toBe("synthetic manager");
    expect(await readPrivateProperty("ExecStartEx", socket)).toEqual([
      { path: runtime, argv, flags: ["no-env-expand"] },
    ]);
    expect(calls).toEqual(["Get", "Get"]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each(["request-rejected", "unrecognized-reply", "transport", "timeout"])(
  "the standalone property reader reports %s without reply or credential data",
  async (category) => {
    const directory = mkdtempSync(join(tmpdir(), "mate-private-failure-"));
    const socket = join(directory, "systemd/private");
    const secret = "synthetic-private-reply-and-download-secret";
    mkdirSync(join(directory, "systemd"));
    const server = createServer((stream) => {
      const connection = dbus.createConnection({ stream, server: true, authMethods: ["EXTERNAL"] });
      connection.on("message", (message) => {
        if (!message.serial) {
          stream.destroy();
          return;
        }
        if (category === "transport") {
          stream.destroy();
          return;
        }
        if (category === "timeout") return;
        connection.message({
          type:
            category === "request-rejected"
              ? dbus.messageType.error
              : dbus.messageType.methodReturn,
          serial: 1,
          replySerial: message.serial,
          errorName: "org.freedesktop.DBus.Error.Failed",
          signature: category === "request-rejected" ? "s" : "v",
          body: category === "request-rejected" ? [secret] : [new Variant("as", [secret])],
        });
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socket, resolve);
      });
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(
            new URL("../../dist/management/service/systemd-property.js", import.meta.url),
          ),
          "Version",
        ],
        { env: { ...process.env, XDG_RUNTIME_DIR: directory, GH_TOKEN: secret }, timeout: 10000 },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (data) => {
        stdout += data.toString();
      });
      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });
      const status = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      expect(status).toBe(1);
      expect(stderr).toContain(`"category":"${category}"`);
      if (category === "timeout") expect(stderr).toContain('"code":"ETIMEDOUT"');
      expect(stdout).toBe("");
      expect(stderr).not.toContain(secret);
      expect(stderr).not.toContain("org.freedesktop.DBus.Error.Failed");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  },
  15000,
);
