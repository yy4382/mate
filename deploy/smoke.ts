// The deploy smoke test: `pnpm smoke:deploy`. Builds the control-plane image and a node bundle for the Docker host's
// architecture, starts the control plane with deploy/control-plane/compose.yaml and a node in a plain Debian container,
// and drives them over HTTP as the owner would, with a scripted model provider on this host. Set MATE_SMOKE_IMAGE to
// check an image that is already built (a release, say) instead of building one.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type AddressInfo, type Server } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ScriptedProvider } from "../packages/testkit/src/index.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PASSWORD = "smoke test admin password";
const VERSION = "0.0.0-smoke";
const PROJECT = "mate-smoke";
const NODE_CONTAINER = "mate-smoke-node";
const REPLY = "Yes, all three finished.";
const settings = { model: { provider: "openai", modelId: "gpt-4.1" } };

// MATE_SMOKE_ARCH (x64 or arm64) runs the other architecture under the Docker host's emulation.
const arch =
  process.env.MATE_SMOKE_ARCH ??
  { aarch64: "arm64", arm64: "arm64", x86_64: "x64", amd64: "x64" }[
    run("docker", ["info", "--format", "{{.Architecture}}"]).trim()
  ];
assert(arch === "arm64" || arch === "x64", "the architecture is x64 or arm64");
const platform = arch === "x64" ? "linux/amd64" : "linux/arm64";

const image = process.env.MATE_SMOKE_IMAGE ?? "mate-control-plane:smoke";
if (process.env.MATE_SMOKE_IMAGE === undefined)
  run(
    "docker",
    [
      "build",
      "--platform",
      platform,
      "--file",
      "deploy/control-plane/Dockerfile",
      "--tag",
      image,
      ".",
    ],
    {
      inherit: true,
    },
  );
const bundles = join(root, "dist/smoke");
run("pnpm", ["bundle:node", VERSION, "--platform", "linux", "--arch", arch, "--out", bundles], {
  inherit: true,
});
const bundle = join(bundles, `mate-node-${VERSION}-linux-${arch}.tar.gz`);

const work = mkdtempSync(join(tmpdir(), "mate-smoke-"));
const data = join(work, "data");
mkdirSync(data, { mode: 0o700 });
const passwordFile = join(work, "initial-password");
writeFileSync(passwordFile, `${PASSWORD}\n`, { mode: 0o600 });
// Containers reach this host as host.docker.internal; Docker on Linux needs the mapping spelled out.
const hostGateway = join(work, "compose.smoke.yaml");
writeFileSync(
  hostGateway,
  'services:\n  control-plane:\n    extra_hosts: ["host.docker.internal:host-gateway"]\n',
);
const port = await freePort();
const composeEnv = {
  ...process.env,
  MATE_IMAGE: image,
  MATE_UID: String(process.getuid?.() ?? 1000),
  MATE_GID: String(process.getgid?.() ?? 1000),
  MATE_DATA: data,
  MATE_INITIAL_PASSWORD: passwordFile,
  MATE_LISTEN: `127.0.0.1:${port}`,
};
const compose = (files: string[], args: string[]) =>
  run(
    "docker",
    [
      "compose",
      "--project-name",
      PROJECT,
      "--project-directory",
      join(root, "deploy/control-plane"),
      ...files.flatMap((file) => ["--file", join(root, "deploy/control-plane", file)]),
      "--file",
      hostGateway,
      ...args,
    ],
    { env: composeEnv, inherit: true },
  );
const initialize = ["compose.yaml", "compose.initialize.yaml"];

const provider = await ScriptedProvider.start();
// The provider listens on this host's loopback only; containers come in through this relay.
const relay = await listen(
  createServer((client) => {
    const upstream = createConnection(Number(new URL(provider.baseUrl).port), "127.0.0.1");
    client.pipe(upstream).pipe(client);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  }),
  "0.0.0.0",
);

let failed = true;
try {
  compose(initialize, ["up", "--detach", "--wait"]);
  const base = `http://127.0.0.1:${port}`;
  let request = browser(base);
  assert.equal(
    (await request("POST", "/api/login", { handle: "admin", password: PASSWORD })).status,
    200,
    "the first admin logs in",
  );

  const { pairingToken } = (await request("POST", "/api/admin/pairing-tokens")).json;
  run("docker", [
    "run",
    "--detach",
    "--name",
    NODE_CONTAINER,
    "--network",
    `${PROJECT}_default`,
    "--platform",
    platform,
    "--volume",
    `${bundle}:/bundles/${basename(bundle)}:ro`,
    "--volume",
    `${bundle}.sha256:/bundles/${basename(bundle)}.sha256:ro`,
    "debian:13",
    "sh",
    "-ec",
    `useradd --create-home owner
     mkdir /fake && printf '#!/bin/sh\\necho ActiveState=inactive\\n' > /fake/systemctl && chmod 755 /fake/systemctl
     exec su owner -c '
       set -e
       export PATH=/fake:$HOME/.local/bin:$PATH
       (cd /bundles && sha256sum -c *.sha256)
       cd /tmp && tar -xzf /bundles/*.tar.gz && ./mate-node/bin/mate node install /bundles/*.tar.gz
       mate node configure --control-plane http://control-plane:8787 --pairing-token ${pairingToken}
       exec mate node run'`,
  ]);
  const node = await waitFor("the node pairs and connects", async () => {
    const nodes = (await request("GET", "/api/admin/nodes")).json as {
      nodeId: string;
      online: boolean;
    }[];
    return nodes.find((each) => each.online);
  });

  const baseUrl = `http://host.docker.internal:${(relay.address() as AddressInfo).port}/v1`;
  const saved = await request("PUT", "/api/admin/providers/openai/credentials", {
    apiKey: "sk-smoke-00000001",
    baseUrl,
  });
  assert.equal(saved.status, 204, `the provider credentials are stored: ${saved.text}`);

  const created = await request("POST", "/api/admin/agents", {
    nodeId: node.nodeId,
    displayName: "Richard",
    handle: "richard",
    settings,
  });
  assert.equal(created.status, 200, `the Agent is created on the node: ${created.text}`);
  const snapshot = (await request("GET", "/api/chat/snapshot")).json as {
    accounts: { accountId: number; handle: string }[];
  };
  const richard = snapshot.accounts.find((account) => account.handle === "richard");
  assert(richard !== undefined, "the Agent has a chat account");
  const dm = (await request("POST", "/api/chat/dms", { requestId: "dm", other: richard.accountId }))
    .json;
  const timeline = { conversation: dm.conversationId as number };

  let read: string[] = [];
  let sent: string[] = [];
  provider
    .step("notice", (request) => {
      read = request.call([{ name: "chat_read_unread", arguments: { timeline } }]);
    })
    .step("reply", (request) => {
      assert.match(
        request.toolOutput(read[0] ?? "") ?? "",
        /Are the backups done\?/,
        "the Agent reads the DM",
      );
      sent = request.call([{ name: "chat_send", arguments: { timeline, body: REPLY } }]);
    })
    .step("done", (request) => {
      assert.match(request.toolOutput(sent[0] ?? "") ?? "", /"status":"sent"/, "the reply is sent");
      request.text("answered");
    });
  const asked = await request("POST", "/api/chat/messages", {
    timeline,
    requestId: "ask",
    body: "Are the backups done?",
  });
  assert.equal(asked.status, 200, `the owner's DM is sent: ${asked.text}`);
  const history = `/api/chat/history?conversation=${timeline.conversation}`;
  await waitFor("the Agent's reply is in the DM", async () =>
    (await request("GET", history)).text.includes(REPLY),
  );
  await provider.received(3);
  provider.assertComplete();

  const stopStarted = Date.now();
  compose(initialize, ["stop", "control-plane"]);
  const container = run("docker", [
    "ps",
    "--all",
    "--quiet",
    "--filter",
    `label=com.docker.compose.project=${PROJECT}`,
  ]).trim();
  assert.equal(
    run("docker", ["inspect", "--format", "{{.State.ExitCode}}", container]).trim(),
    "0",
    "SIGTERM exits 0",
  );
  assert.match(
    run("docker", ["logs", container]),
    /SIGTERM, stopping/,
    "the control plane handled SIGTERM",
  );
  assert(
    Date.now() - stopStarted < 9_000,
    "the control plane stopped before Compose's 10 s kill deadline",
  );

  compose(["compose.yaml"], ["up", "--detach", "--wait"]);
  request = browser(base);
  const again = await request("POST", "/api/login", { handle: "admin", password: PASSWORD });
  assert.equal(
    again.status,
    200,
    "the stored password still logs in, without the initial password file",
  );
  const agents = (await request("GET", "/api/admin/agents")).json;
  assert.deepEqual(
    agents.map((agent: { handle: string; state: string }) => [agent.handle, agent.state]),
    [["richard", "open"]],
    "the Agent survives the restart and reopens",
  );
  assert((await request("GET", history)).text.includes(REPLY), "the DM survives the restart");
  await waitFor("the node reconnects", async () =>
    ((await request("GET", "/api/admin/nodes")).json as { nodeId: string; online: boolean }[]).some(
      (each) => each.nodeId === node.nodeId && each.online,
    ),
  );
  failed = false;
  console.log("deploy smoke: ok");
} finally {
  if (failed) {
    compose(initialize, ["logs", "--no-color"]);
    spawnSync("docker", ["logs", NODE_CONTAINER], { stdio: "inherit" });
  }
  spawnSync("docker", ["rm", "--force", NODE_CONTAINER], { stdio: "ignore" });
  compose(initialize, ["down"]);
  relay.close();
  await provider.close();
  rmSync(work, { recursive: true, force: true });
}

/** The owner's browser: it keeps the session cookie, as a browser would. */
function browser(base: string) {
  let cookie: string | undefined;
  return async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; text: string; json: any }> => {
    const response = await fetch(base + path, {
      method,
      redirect: "manual",
      headers: {
        connection: "close",
        ...(cookie === undefined ? {} : { cookie }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    cookie = response.headers.get("set-cookie")?.split(";")[0] ?? cookie;
    const text = await response.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: response.status, text, json };
  };
}

/** Poll `check` until it returns something truthy, for up to a minute. */
async function waitFor<T>(what: string, check: () => Promise<T | undefined | false>): Promise<T> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const result = await check().catch(() => undefined);
    if (result) return result;
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
    await new Promise((done) => setTimeout(done, 500));
  }
}

function run(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; inherit?: boolean } = {},
): string {
  const result = spawnSync(command, args, {
    cwd: root,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "inherit"],
  });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  return result.stdout ?? "";
}

async function listen(server: Server, host: string): Promise<Server> {
  await new Promise<void>((done) => server.listen(0, host, done));
  return server;
}

async function freePort(): Promise<number> {
  const server = await listen(createServer(), "127.0.0.1");
  const { port } = server.address() as AddressInfo;
  await new Promise((done) => server.close(done));
  return port;
}
