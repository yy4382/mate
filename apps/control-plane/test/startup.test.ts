import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HumanBrowser, temporaryDirectory } from "@palace/testkit";
import { expect, it, onTestFinished } from "vitest";

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const password = "stdin credential boundary test password";
const { privateKey } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});

function launch(input: string, extra: Record<string, string> = {}, keepInputOpen = false) {
  const directory = temporaryDirectory();
  const passwordFile = join(directory, "password");
  writeFileSync(passwordFile, password);
  const child = spawn(process.execPath, ["--conditions=palace-source", main], {
    env: {
      ...process.env,
      PALACE_DATA_DIRECTORY: join(directory, "data"),
      PALACE_INITIAL_PASSWORD_FILE: passwordFile,
      PALACE_HOST: "127.0.0.1",
      PALACE_PORT: "0",
      PALACE_APNS_KEY_FILE: undefined,
      PALACE_APNS_KEY_STDIN: "1",
      PALACE_APNS_KEY_ID: "TESTKEY001",
      PALACE_APNS_TEAM_ID: "TESTTEAM01",
      PALACE_APNS_TOPIC: "dev.yyang.palace",
      PALACE_APNS_ENVIRONMENT: "production",
      ...extra,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let ready: ((url: string) => void) | undefined;
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
      const url = /palace control plane listening on (http:\/\/\S+)/.exec(output)?.[1];
      if (url) ready?.(url);
    });
  }
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  child.stdin.on("error", () => {});
  if (keepInputOpen) child.stdin.write(input);
  else child.stdin.end(input);
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  return {
    child,
    exited,
    output: () => output,
    listening: () =>
      Promise.race([
        new Promise<string>((resolve) => {
          ready = resolve;
        }),
        exited.then(() => {
          throw new Error(`control plane exited before listening: ${output}`);
        }),
      ]),
  };
}

it("starts native push before stdin closes and shuts down on SIGTERM", async () => {
  const plane = launch(privateKey, {}, true);
  const browser = new HumanBrowser(await plane.listening());
  await browser.logIn("admin", password);
  expect((await browser.get("/api/chat/push/native")).json).toEqual({
    enabled: true,
    environment: "production",
  });
  plane.child.kill("SIGTERM");
  expect(await plane.exited).toBe(0);
  expect(plane.output()).not.toContain(privateKey.trim());
});

it.each([
  "",
  "private-input-marker",
  "-----BEGIN PRIVATE KEY-----\nprivate-input-marker\n-----END PRIVATE KEY-----",
  "private-input-marker".repeat(2000),
])("rejects unusable stdin credentials without exposing their contents", async (input) => {
  const plane = launch(input);
  expect(await plane.exited).toBe(2);
  expect(plane.output()).not.toContain("private-input-marker");
  expect(plane.output()).not.toContain("listening on");
});

it("rejects simultaneous file and stdin sources before starting", async () => {
  const plane = launch(privateKey, { PALACE_APNS_KEY_FILE: "/unused.p8" });
  expect(await plane.exited).toBe(2);
  expect(plane.output()).toContain("choose one APNs key source");
  expect(plane.output()).not.toContain(privateKey.trim());
});
