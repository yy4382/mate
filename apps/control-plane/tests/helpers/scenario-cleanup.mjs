// Independent recovery after the scenario driver is killed. Only explicit owned manifests are read.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

function pidExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}
function processState(pid) {
  try {
    const output = execFileSync("ps", ["-p", String(pid), "-o", "stat=", "-o", "command="], {
      encoding: "utf8",
      timeout: 2000,
    }).trim();
    const match = /^(\S+)\s+(.+)$/.exec(output);
    if (!match) throw new Error(`Unable to read process ${pid} state`);
    return { state: match[1], command: match[2] };
  } catch (error) {
    if (error.status === 1 && !pidExists(pid)) return undefined;
    throw error;
  }
}
// Zombies have exited and released their resources, even though kill(pid, 0) still succeeds.
function exited(actual) {
  return actual === undefined || actual.state.startsWith("Z");
}
function dockerInspect(kind, id) {
  try {
    return JSON.parse(
      execFileSync("docker", [kind, "inspect", id], {
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    )[0];
  } catch (error) {
    if (/No such (object|container|network)|network [^\n]+ not found/i.test(String(error.stderr)))
      return undefined;
    throw error;
  }
}
async function cleanup(file) {
  const report = {
    manifest: file,
    released: [],
    residual: [],
    errors: [],
    observations: [],
    signals: [],
  };
  try {
    if (lstatSync(file).isSymbolicLink()) throw new Error("Refusing symlink resource manifest");
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    if (
      manifest.version !== 1 ||
      !isAbsolute(manifest.directory) ||
      !basename(manifest.directory).startsWith("mate-scenario-") ||
      typeof manifest.ownership !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(manifest.ownership) ||
      !Number.isSafeInteger(manifest.driverPid) ||
      !Array.isArray(manifest.processes)
    )
      throw new Error("Invalid scenario resource manifest");
    const directoryPresent = existsSync(manifest.directory);
    if (
      directoryPresent &&
      (lstatSync(manifest.directory).isSymbolicLink() ||
        readFileSync(join(manifest.directory, ".mate-scenario-owner"), "utf8") !==
          manifest.ownership)
    )
      throw new Error("Scenario directory ownership mismatch");
    const driverAlive = !exited(processState(manifest.driverPid));
    if (directoryPresent && driverAlive)
      throw new Error("Scenario driver is still alive; use its registered close() instead");
    for (const output of [...manifest.processes].reverse()) {
      try {
        if (
          !Number.isSafeInteger(output.pid) ||
          output.pid < 1 ||
          typeof output.marker !== "string" ||
          !output.marker.endsWith(` ${manifest.ownership}`) ||
          !["node", "control-plane"].includes(output.service)
        )
          throw new Error("Invalid owned process identity");
        function observe(phase) {
          const actual = processState(output.pid);
          // Record state and the comparison, never an unrelated process's potentially secret argv.
          const observation = {
            service: output.service,
            pid: output.pid,
            phase,
            state: actual?.state ?? "absent",
            identityMatches: actual?.command.endsWith(output.marker) ?? false,
          };
          if (JSON.stringify(report.observations.at(-1)) !== JSON.stringify(observation))
            report.observations.push(observation);
          return actual;
        }
        function requireIdentity(actual) {
          if (!actual.command.endsWith(output.marker))
            throw new Error(
              `Process ${output.pid} identity changed; no ${report.signals.some((entry) => entry.pid === output.pid) ? "further " : ""}signal sent`,
            );
        }
        function inspect(phase) {
          const actual = observe(phase);
          // An exit can happen during ps's argv read. Confirm before declaring a live mismatch.
          return !exited(actual) && !actual.command.endsWith(output.marker)
            ? observe(`${phase} confirm`)
            : actual;
        }
        let actual = inspect("initial");
        if (exited(actual)) {
          report.released.push(
            `${output.service} ${output.pid} already ${actual ? "exited" : "absent"}`,
          );
          continue;
        }
        requireIdentity(actual);
        if (driverAlive) throw new Error("Scenario driver is still alive; no signal sent");
        for (const signal of ["SIGTERM", "SIGKILL"]) {
          actual = inspect(`before ${signal}`);
          if (exited(actual)) break;
          requireIdentity(actual);
          try {
            process.kill(output.pid, signal);
            report.signals.push({ service: output.service, pid: output.pid, signal });
          } catch (error) {
            // The identified service may exit between the observation and the signal.
            if (error.code !== "ESRCH") throw error;
            actual = inspect(`${signal} race`);
            if (!exited(actual)) throw error;
          }
          for (let index = 0; index < 80; index++) {
            actual = inspect(signal);
            if (exited(actual)) break;
            requireIdentity(actual);
            await delay(25);
          }
          if (exited(actual)) break;
        }
        if (!exited(actual)) throw new Error(`Process ${output.pid} did not exit`);
        report.released.push(`${output.service} ${output.pid}`);
      } catch (error) {
        report.residual.push(output);
        report.errors.push(String(error));
      }
    }
    for (const resource of [...(manifest.containers ?? [])].reverse()) {
      try {
        if (driverAlive) throw new Error("Scenario driver is still alive; no Docker removal sent");
        if (
          !(resource.id === "" || /^[0-9a-f]{64}$/.test(resource.id)) ||
          resource.ownership !== manifest.ownership ||
          resource.project !== `mate-a-scenario-${manifest.ownership}` ||
          !Array.isArray(resource.networks) ||
          !resource.networks.every((id) => /^[0-9a-f]{64}$/.test(id))
        )
          throw new Error("Invalid owned Docker identity");
        const ids = resource.id
          ? [resource.id]
          : execFileSync(
              "docker",
              [
                "container",
                "ls",
                "--all",
                "--quiet",
                "--no-trunc",
                "--filter",
                `label=com.docker.compose.project=${resource.project}`,
              ],
              { encoding: "utf8", timeout: 10_000 },
            )
              .trim()
              .split(/\s+/)
              .filter(Boolean);
        for (const id of ids) {
          const container = dockerInspect("container", id);
          if (container) {
            if (
              container.Config.Labels["mate.scenario.owner"] !== manifest.ownership ||
              container.Config.Labels["com.docker.compose.project"] !== resource.project
            )
              throw new Error("Container ownership mismatch; no removal sent");
            execFileSync("docker", ["container", "rm", "--force", id], {
              timeout: 10_000,
              stdio: "pipe",
            });
          }
          report.released.push(`container ${id} ${container ? "removed" : "already absent"}`);
        }
        for (const id of resource.networks.length
          ? resource.networks
          : [`${resource.project}_default`]) {
          const network = dockerInspect("network", id);
          if (network) {
            if (network.Labels["com.docker.compose.project"] !== resource.project)
              throw new Error("Network ownership mismatch; no removal sent");
            execFileSync("docker", ["network", "rm", id], { timeout: 10_000, stdio: "pipe" });
          }
          report.released.push(`network ${id} ${network ? "removed" : "already absent"}`);
        }
      } catch (error) {
        report.residual.push(resource);
        report.errors.push(String(error));
      }
    }
    if (!report.residual.length) {
      if (directoryPresent) rmSync(manifest.directory, { recursive: true, force: true });
      report.released.push(
        directoryPresent ? "synthetic directory" : "synthetic directory already absent",
      );
    }
  } catch (error) {
    report.errors.push(String(error));
    report.residual.push({ resource: file });
  }
  return report;
}

const arguments_ = process.argv.slice(2);
if (arguments_[0] === "--") arguments_.shift();
let files;
if (arguments_[0] === "--root" && arguments_.length === 2) {
  const root = resolve(arguments_[1]);
  function ownedManifests(directory) {
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      if (!entry.isDirectory() || !entry.name.startsWith("scenario-")) return [];
      const child = join(directory, entry.name);
      return [
        ...(existsSync(join(child, "resources.json")) ? [join(child, "resources.json")] : []),
        ...ownedManifests(child),
      ];
    });
  }
  files = ownedManifests(root);
} else if (arguments_.length === 1) files = [resolve(arguments_[0])];
else {
  console.error("Usage: pnpm cleanup:scenarios -- --root <evidence-root> | <resources.json>");
  process.exit(1);
}
const reports = [];
for (const file of files) {
  const report = await cleanup(file);
  reports.push(report);
  try {
    writeFileSync(
      join(dirname(file), "independent-cleanup.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      { mode: 0o600 },
    );
  } catch (error) {
    report.errors.push(String(error));
  }
}
console.log(
  JSON.stringify(
    {
      guarantee:
        "best effort; SIGKILL does not execute finally; only manifest-owned service identities and marked directories are reclaimed",
      reports,
    },
    null,
    2,
  ),
);
if (reports.some((report) => report.errors.length || report.residual.length)) process.exitCode = 1;
