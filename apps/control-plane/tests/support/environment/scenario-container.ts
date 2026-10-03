import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { release } from "node:os";
import { z } from "zod";
import { ProcessOutput } from "./run-services.js";

const imageSchema = z.object({
  Id: z.string(),
  Os: z.literal("linux"),
  Architecture: z.string(),
  Config: z.object({ Labels: z.record(z.string(), z.string()) }),
});
const containerSchema = z.object({
  Id: z.string(),
  Image: z.string(),
  Config: z.object({
    User: z.string(),
    Env: z.string().array(),
    Labels: z.record(z.string(), z.string()),
  }),
  State: z.object({ Running: z.boolean(), ExitCode: z.number(), OOMKilled: z.boolean() }),
  HostConfig: z.object({
    PortBindings: z.record(
      z.string(),
      z.array(z.object({ HostIp: z.string(), HostPort: z.string() })),
    ),
  }),
  Mounts: z.array(z.object({ Source: z.string(), Destination: z.string(), RW: z.boolean() })),
  NetworkSettings: z.object({
    Networks: z.record(z.string(), z.object({ NetworkID: z.string() })),
  }),
});

/** Test-only lifecycle around B's unchanged image and production Compose. */
export function createScenarioContainer(options: {
  image: string;
  directory: string;
  ownership: string;
  save: (resource: { id: string; project: string; ownership: string; networks: string[] }) => void;
}) {
  const root = fileURLToPath(new URL("../../../../..", import.meta.url));
  const uid = process.getuid?.(),
    gid = process.getgid?.();
  assert.ok(
    uid && gid,
    "Container scenarios require an existing nonroot account with nonzero UID/GID",
  );
  const project = `mate-a-scenario-${options.ownership}`;
  const data = join(options.directory, "control-plane-data");
  mkdirSync(data, { mode: 0o700 });
  const override = join(options.directory, "compose.scenario.json");
  const files = [
    join(root, "deploy/control-plane/compose.yaml"),
    join(root, "deploy/control-plane/compose.initialize.yaml"),
    override,
  ];
  const environment = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
    MATE_CONTROL_PLANE_IMAGE: options.image,
    MATE_UID: String(uid),
    MATE_GID: String(gid),
    MATE_CONTROL_PLANE_DATA_DIR: data,
    MATE_OWNER_PASSWORD_FILE: join(options.directory, "owner-password"),
  };
  function docker(args: string[]) {
    return execFileSync("docker", args, {
      cwd: root,
      env: environment,
      encoding: "utf8",
      timeout: 30_000,
    }).trim();
  }
  function compose(args: string[]) {
    return docker([
      "compose",
      "--project-name",
      project,
      ...files.flatMap((file) => ["--file", file]),
      ...args,
    ]);
  }
  const image = z
    .tuple([imageSchema])
    .rest(imageSchema)
    .parse(JSON.parse(docker(["image", "inspect", options.image])))[0];
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  assert.equal(
    image.Config.Labels["org.opencontainers.image.revision"],
    sha,
    "Image must be built from this checkout SHA",
  );
  let id = "";
  const topology = {
    image: options.image,
    imageId: image.Id,
    sourceSha: sha,
    imagePlatform: `${image.Os}/${image.Architecture}`,
    uid,
    gid,
    project,
    host: {
      platform: process.platform,
      architecture: process.arch,
      runtime: process.version,
      kernel: release(),
    },
    node: {
      entry: "apps/node/dist via scenario-services.mjs",
      runtime: process.execPath,
      platform: process.platform,
      arch: process.arch,
      kernel: release(),
      uid,
      gid,
      serviceManager: "ordinary child process",
    },
    origin: "http://127.0.0.1:8787",
    production: { web: false, login: false, pairedNode: "", container: {} },
    wrapper: { launcher: "scenario-services.mjs", containers: containerSchema.array().parse([]) },
  };
  function inspect() {
    const state = containerSchema.array().parse(JSON.parse(docker(["inspect", id])))[0];
    assert.ok(state);
    return state;
  }
  function start(input: NodeJS.ProcessEnv, wrapped: boolean) {
    const service = {
      labels: { "mate.scenario.owner": options.ownership },
      ...(wrapped
        ? {
            entrypoint: [
              "node",
              "/opt/mate/apps/control-plane/tests/support/environment/scenario-services.mjs",
              "control-plane",
              options.ownership,
            ],
            environment: Object.fromEntries(
              Object.entries(input).filter(([name]) => name.startsWith("MATE_SCENARIO_")),
            ),
            extra_hosts: ["host.docker.internal:host-gateway"],
            volumes: [
              {
                type: "bind",
                source: join(
                  root,
                  "apps/control-plane/tests/support/environment/scenario-services.mjs",
                ),
                target:
                  "/opt/mate/apps/control-plane/tests/support/environment/scenario-services.mjs",
                read_only: true,
                bind: { create_host_path: false },
              },
            ],
          }
        : {}),
    };
    writeFileSync(override, JSON.stringify({ services: { "control-plane": service } }), {
      mode: 0o600,
    });
    // Persist the project before Compose can create its network or a partially started service.
    options.save({ id: "", project, ownership: options.ownership, networks: [] });
    compose(["create", "--force-recreate", "--pull", "never", "control-plane"]);
    id = compose(["ps", "--all", "--quiet", "control-plane"]);
    const state = inspect();
    const network = z
      .tuple([z.object({ Id: z.string() })])
      .parse(JSON.parse(docker(["network", "inspect", `${project}_default`])))[0];
    options.save({ id, project, ownership: options.ownership, networks: [network.Id] });
    assert.equal(state.Image, image.Id);
    assert.equal(state.Config.User, `${uid}:${gid}`);
    assert.ok(state.Config.Env.includes("MATE_CONTROL_PLANE_HOST=0.0.0.0"));
    assert.deepEqual(state.HostConfig.PortBindings, {
      "8787/tcp": [{ HostIp: "127.0.0.1", HostPort: "8787" }],
    });
    assert.deepEqual(
      state.Mounts.map((mount) => mount.Destination).sort(),
      [
        "/run/mate/owner-password",
        "/var/lib/mate/control-plane",
        ...(wrapped
          ? ["/opt/mate/apps/control-plane/tests/support/environment/scenario-services.mjs"]
          : []),
      ].sort(),
    );
    assert.ok(
      !state.Mounts.some(
        (mount) => mount.Source.includes("workspaces") || mount.Destination.includes("node-data"),
      ),
    );
    if (wrapped) topology.wrapper.containers.push(state);
    else topology.production.container = state;
    return new ProcessOutput(
      spawn("docker", ["start", "--attach", id], {
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  }
  async function stop(output: ProcessOutput, signal: "SIGTERM" | "SIGKILL") {
    if (!output.exitStatus) {
      docker(["kill", "--signal", signal === "SIGKILL" ? "KILL" : "TERM", id]);
      await Promise.race([
        output.exited,
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Container attach did not exit")), 5000);
          timer.unref();
        }),
      ]);
    }
    const state = inspect();
    assert.equal(state.State.Running, false);
    assert.equal(state.State.OOMKilled, false);
    if (signal === "SIGKILL") assert.equal(state.State.ExitCode, 137);
    return { signal, container: { id, ...state.State }, attachExit: output.exitStatus };
  }
  function runtimeFacts() {
    const runtime = JSON.parse(
      docker([
        "exec",
        id,
        "node",
        "--input-type=module",
        "-e",
        `
        import { networkInterfaces, release } from 'node:os';
        const address = Object.values(networkInterfaces()).flat().find(entry => !entry.internal && entry.family === 'IPv4')?.address;
        if (!address || !(await fetch('http://' + address + ':8787/api/status')).ok) throw new Error('Container interface listener unavailable');
        console.log(JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version, kernel: release(), uid: process.getuid(), gid: process.getgid(), interfaceAddress: address }));
      `,
      ]),
    );
    const checked = z
      .object({
        platform: z.literal("linux"),
        arch: z.string(),
        node: z.string(),
        kernel: z.string(),
        uid: z.literal(uid),
        gid: z.literal(gid),
        interfaceAddress: z.string(),
      })
      .parse(runtime);
    return checked;
  }
  return {
    topology,
    start,
    stop,
    verifyProduction(nodeId: string) {
      const checked = runtimeFacts();
      topology.production = {
        web: true,
        login: true,
        pairedNode: nodeId,
        container: { ...inspect(), runtime: checked },
      };
      console.log(
        `MATE_CONTAINER_PRODUCTION ${JSON.stringify({ image: topology.image, imageId: topology.imageId, sourceSha: sha, imagePlatform: topology.imagePlatform, host: topology.host, uid, gid, project, originalEntrypoint: true, web: true, login: true, pairedNode: nodeId, runtime: checked, ports: inspect().HostConfig.PortBindings, mounts: inspect().Mounts, node: topology.node })}`,
      );
    },
    reportWrapper() {
      const state = inspect();
      assert.equal(state.State.Running, true);
      assert.equal(state.Image, image.Id);
      assert.equal(state.Config.User, `${uid}:${gid}`);
      const runtime = runtimeFacts();
      console.log(
        `MATE_CONTAINER_WRAPPER ${JSON.stringify({ sourceSha: sha, image: options.image, imageId: state.Image, imagePlatform: topology.imagePlatform, project, containerId: state.Id, runtime, node: topology.node, entrypoint: "/opt/mate/apps/control-plane/tests/support/environment/scenario-services.mjs", testDependencies: state.Config.Env.filter((value) => value.startsWith("MATE_SCENARIO_")).map((value) => value.split("=")[0]), ports: state.HostConfig.PortBindings, mounts: state.Mounts })}`,
      );
    },
    providerUrl: (port: number) => `http://host.docker.internal:${port}/v1`,
    close: () => {
      compose(["down", "--volumes", "--remove-orphans"]);
    },
  };
}
