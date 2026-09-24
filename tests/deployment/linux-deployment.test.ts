import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertConfigurationEvolution, daemonConfigSchema } from "../../src/daemon/config.js";
import { deploymentSpecSchema } from "../../src/deployment/spec.js";
import { createLinuxDeploymentPlan } from "../../src/deployment/linux-plan.js";
import {
  preflightLinuxDeployment,
  renderAgentSlice,
  renderLinuxService,
  renderLinuxMaintenanceWrapper,
} from "../../src/deployment/linux-installer.js";
import { runDoctor } from "../../src/deployment/doctor.js";
import { SimulatedHost, deploymentCommands, type SimulatedHostOptions } from "../helpers/host.js";

const binaries = [
  "/usr/bin/systemctl",
  "/usr/bin/systemd-run",
  "/usr/bin/setpriv",
  "/usr/bin/getent",
  "/usr/bin/id",
  "/usr/bin/node",
  "/usr/bin/cp",
  "/usr/bin/chown",
  "/usr/bin/chmod",
];
const accounts = {
  "mate-alice": { uid: 2001, gid: 2001, home: "/srv/mate/private/alice" },
  "mate-bob": { uid: 2002, gid: 2002, home: "/srv/mate/private/bob" },
};
const config = () =>
  daemonConfigSchema.parse({
    version: 2,
    mate: {
      ownerUserIds: ["owner"],
      runTimeoutMs: 60000,
      agents: [
        {
          id: "alice",
          name: "Alice",
          role: "Research",
          model: { provider: "anthropic", id: "model", apiKeyEnv: "MODEL_KEY" },
        },
        {
          id: "bob",
          name: "Bob",
          role: "Writing",
          model: { provider: "anthropic", id: "model", apiKeyEnv: "MODEL_KEY" },
        },
      ],
    },
    adapters: { local: { humans: ["owner"], rooms: [] } },
    runtime: {
      dataDir: "/var/lib/mate",
      sharedRoot: "/srv/mate/shared",
      linuxUsers: {
        alice: {
          uid: 2001,
          gid: 2001,
          username: "mate-alice",
          home: "/srv/mate/private/alice",
        },
        bob: {
          uid: 2002,
          gid: 2002,
          username: "mate-bob",
          home: "/srv/mate/private/bob",
        },
      },
    },
  });
const spec = () =>
  deploymentSpecSchema.parse({
    version: 1,
    release: { source: "/candidate", gitCommit: "abcdef1234567" },
    configSource: "/input/mate.json",
  });
/** A Debian 13 host with a candidate release tree; every operation goes through the host entry. */
function debianHost(overrides: SimulatedHostOptions = {}) {
  const host = new SimulatedHost({
    ...overrides,
    directories: { "/candidate/node_modules": 0o755, ...overrides.directories },
    executables: [...binaries, ...(overrides.executables ?? [])],
    files: {
      "/etc/os-release": 'ID=debian\nVERSION_ID="13"\n',
      "/candidate/dist/main.js": "one",
      "/candidate/package.json": "{}",
      "/candidate/pnpm-lock.yaml": "lockfileVersion: 9",
      ...overrides.files,
    },
  });
  return host.onCommand(
    overrides.run ?? deploymentCommands(host, { accounts, node: overrides.node ?? "v24.0.0" }),
  );
}

it("plans one ordinary Linux identity per Agent with a shared root, no Docker image or volumes", async () => {
  const plan = await createLinuxDeploymentPlan(spec(), config(), debianHost());
  expect(plan.mode).toBe("linux-users");
  expect(plan.agents.map((item) => [item.agentId, item.uid, item.home])).toEqual([
    ["alice", 2001, "/srv/mate/private/alice"],
    ["bob", 2002, "/srv/mate/private/bob"],
  ]);
  expect(plan.agents.map((item) => item.slice)).toEqual([
    "mate-agent-2001.slice",
    "mate-agent-2002.slice",
  ]);
  expect(plan.permissions).toEqual({
    mateData: "root:root 0700",
    configAndSecrets: "root:root 0600",
    privateHomes: "Agent UID:GID 0700",
    sharedRoot: "root:root 0755",
    sharedAgentDirectories: "Agent UID:GID 0755",
  });
  expect(JSON.stringify(plan)).not.toContain("docker");
  expect(renderAgentSlice()).toContain("TasksMax=128");
  expect(renderLinuxService(plan)).toContain("User=root");
  expect(renderLinuxService(plan)).toContain("Type=notify");
  expect(renderLinuxService(plan)).toContain("NotifyAccess=all");
  expect(renderLinuxService(plan)).not.toContain("docker.service");
  expect(renderLinuxMaintenanceWrapper()).toContain(
    "--property=EnvironmentFile=/etc/mate/mate.env",
  );
  expect(renderLinuxMaintenanceWrapper()).toContain(
    '/opt/mate/controller/dist/src/deployment/cli.js "$1"',
  );
  const root = mkdtempSync(join(tmpdir(), "mate-linux-wrapper-"));
  try {
    const path = join(root, "matectl");
    writeFileSync(path, renderLinuxMaintenanceWrapper());
    expect(() => execFileSync("/bin/sh", ["-n", path])).not.toThrow();
  } finally {
    rmSync(root, { recursive: true });
  }
});

it("rejects old loopback specs, control overlap, aliased paths and missing Linux usernames", async () => {
  expect(() =>
    deploymentSpecSchema.parse({
      ...spec(),
      privateWorkspaces: [{ agentId: "alice", capacityMiB: 64 }],
    }),
  ).toThrow();
  const overlapping = daemonConfigSchema.parse({
    ...config(),
    runtime: { ...config().runtime, sharedRoot: "/var/lib/mate/shared" },
  });
  await expect(createLinuxDeploymentPlan(spec(), overlapping, debianHost())).rejects.toThrow(
    "overlaps",
  );
  await expect(
    createLinuxDeploymentPlan(
      spec(),
      config(),
      debianHost({ canonical: (path) => (path === "/candidate" ? "/real-candidate" : path) }),
    ),
  ).rejects.toThrow("canonical");
  const nameless = daemonConfigSchema.parse({
    ...config(),
    runtime: {
      ...config().runtime,
      linuxUsers: {
        ...config().runtime.linuxUsers,
        alice: { uid: 2001, gid: 2001, home: "/srv/mate/private/alice" },
      },
    },
  });
  await expect(createLinuxDeploymentPlan(spec(), nameless, debianHost())).rejects.toThrow(
    "username",
  );
});

it("keeps Linux UID and private-home identity stable through configuration migration", () => {
  const previous = config(),
    next = structuredClone(previous);
  next.mate.agents[0]!.role = "Revised role";
  expect(() => assertConfigurationEvolution(previous, next)).not.toThrow();
  next.runtime.linuxUsers!.alice!.uid = 2020;
  expect(() => assertConfigurationEvolution(previous, next)).toThrow("topology");
});

it("preflights Debian, normal passwd identities, disk, memory and inactive service without mutations", async () => {
  const host = debianHost();
  expect((await preflightLinuxDeployment(host, spec(), config())).mode).toBe("linux-users");
  expect(host.commands.some((call) => call.binary.includes("docker"))).toBe(false);
  expect(
    host.ops.filter((event) =>
      ["mkdir", "chown", "chmod", "createExclusive", "rename", "remove", "symlink"].includes(
        event.op,
      ),
    ),
  ).toEqual([]);
  await expect(
    preflightLinuxDeployment(debianHost({ memoryMiB: 128 }), spec(), config()),
  ).rejects.toThrow("memory");
  await expect(
    preflightLinuxDeployment(debianHost({ node: "v24.1.0" }), spec(), config()),
  ).rejects.toThrow("differs");
  await expect(
    preflightLinuxDeployment(
      debianHost({
        run: deploymentCommands(debianHost(), { accounts, activeState: "active" }),
      }),
      spec(),
      config(),
    ),
  ).rejects.toThrow("Stop mate.service");
});

it("rejects system approval when no configured Slack owner can receive its request", async () => {
  const base = config();
  const withSlack = (principals: Record<string, string>) =>
    daemonConfigSchema.parse({
      ...base,
      adapters: {
        slack: {
          teamId: "TTEST",
          principals,
          bindings: [
            {
              agentId: "alice",
              slackAppId: "AALICE",
              slackUserId: "UALICE",
              slackBotId: "BALICE",
              botTokenEnv: "ALICE_BOT",
              appTokenEnv: "ALICE_APP",
              channels: {},
            },
          ],
        },
      },
      runtime: { ...base.runtime, systemAgents: ["alice"] },
    });
  const approval = async (c: ReturnType<typeof withSlack>) =>
    (await runDoctor(debianHost(), c, { requireSecrets: false })).checks.find(
      (check) => check.name === "system-approval",
    );
  expect(await approval(withSlack({ UOTHER: "other" }))).toMatchObject({
    status: "fail",
  });
  expect(await approval(withSlack({ UOWNER: "owner" }))).toMatchObject({
    status: "pass",
  });
});
