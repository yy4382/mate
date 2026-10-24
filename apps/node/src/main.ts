#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { readConfig, writeConfig } from "./config.ts";
import {
  EXIT_DO_NOT_RESTART,
  install,
  logs,
  start,
  status,
  stop,
  uninstall,
  update,
} from "./installation.ts";
import { writeLink } from "./link.ts";
import { NodeRejectedError, startNode } from "./node.ts";
import { currentPlatform } from "./platforms/index.ts";

const USAGE = `Usage:
  mate node install <bundle.tar.gz>     install the program, the \`mate\` command and the service
  mate node update <bundle.tar.gz>      replace the program while the service is stopped
  mate node uninstall                   remove what install added; keeps config, identity and workspaces
  mate node configure --control-plane <url> [--pairing-token <token>] [--workspaces <dir>]
  mate node start | stop | status
  mate node logs [--lines <n>] [--follow]
  mate node run                         run the node in the foreground (what the service runs)`;

const [scope, command, ...rest] = process.argv.slice(2);
if (scope !== "node" || command === undefined) usage();
if (command === "run") await run(rest);
if (process.getuid?.() === 0) {
  fail("Refusing to run as root; run `mate` as the account the node and its Agents run as.");
}
try {
  process.exitCode = await manage(command, rest);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

async function manage(command: string, args: string[]): Promise<number> {
  const paths = currentPlatform().layout();
  const print = (lines: string[]) => {
    process.stdout.write(`${lines.join("\n")}\n`);
    return 0;
  };
  switch (command) {
    case "install":
      return print(await install(bundleArgument(args), paths));
    case "update":
      return print(await update(bundleArgument(args), paths));
    case "uninstall":
      noArguments(args);
      return print(uninstall(paths));
    case "start":
      noArguments(args);
      return print(start(paths));
    case "stop":
      noArguments(args);
      return print(stop(paths));
    case "status":
      noArguments(args);
      return print(status(paths));
    case "logs": {
      const { values } = parsed(() =>
        parseArgs({
          args,
          options: {
            lines: { type: "string", default: "100" },
            follow: { type: "boolean", default: false },
          },
        }),
      );
      if (!/^\d+$/.test(values.lines)) usage();
      return logs(paths, Number(values.lines), values.follow);
    }
    case "configure": {
      const { values } = parsed(() =>
        parseArgs({
          args,
          options: {
            "control-plane": { type: "string" },
            "pairing-token": { type: "string" },
            workspaces: { type: "string", default: paths.workspaces },
          },
        }),
      );
      if (values["control-plane"] === undefined) usage();
      const config = writeConfig(paths.config, {
        controlPlaneUrl: values["control-plane"],
        workspacesRoot: resolve(values.workspaces),
        pairingToken: values["pairing-token"],
      });
      return print([
        `Wrote ${paths.config}: control plane ${config.controlPlaneUrl}, workspaces ${config.workspacesRoot}, ${config.pairingToken === undefined ? "no pairing token" : "with a pairing token"}.`,
        "It takes effect the next time the node starts.",
      ]);
    }
  }
  return usage();
}

async function run(args: string[]): Promise<never> {
  const { values } = parsed(() =>
    parseArgs({ args, options: { service: { type: "boolean", default: false } } }),
  );
  const paths = currentPlatform().layout();
  const service = currentPlatform().service(paths);
  const report = (message: string) => {
    if (values.service) service.report(message);
    else process.stderr.write(`${message}\n`);
  };
  function exit(code: number): never {
    process.exit(values.service ? service.exitCode(code) : code);
  }
  const controller = new AbortController();
  process.on("SIGTERM", () => controller.abort());
  process.on("SIGINT", () => controller.abort());
  let config;
  try {
    config = readConfig(paths.config);
  } catch (error) {
    report((error as Error).message);
    exit(EXIT_DO_NOT_RESTART);
  }
  if (config === undefined) {
    report(`${paths.config} is missing; run \`mate node configure\` first`);
    exit(EXIT_DO_NOT_RESTART);
  }
  try {
    await startNode(
      {
        controlPlaneUrl: config.controlPlaneUrl,
        dataDirectory: paths.data,
        workspacesRoot: config.workspacesRoot,
        pairingToken: config.pairingToken,
        onLink: (connected) => writeLink(paths.data, connected),
      },
      controller.signal,
    );
    exit(0);
  } catch (error) {
    report(`Node exiting: ${error instanceof Error ? error.message : String(error)}`);
    exit(error instanceof NodeRejectedError ? EXIT_DO_NOT_RESTART : 1);
  }
}

/** `parseArgs` throws on unknown options and positionals; those are usage errors. */
function parsed<T>(parse: () => T): T {
  try {
    return parse();
  } catch {
    return usage();
  }
}

function bundleArgument(args: string[]): string {
  if (args.length !== 1 || args[0]!.startsWith("-")) usage();
  return resolve(args[0]!);
}

function noArguments(args: string[]): void {
  if (args.length > 0) usage();
}

function usage(): never {
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}

function fail(message: string): never {
  process.stderr.write(`mate: ${message}\n`);
  process.exit(1);
}
