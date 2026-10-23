import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { host } from "./cli-support.ts";

const releaseBundles = process.env["MATE_TEST_BUNDLE_DIRECTORY"];
const updateBundles = process.env["MATE_TEST_UPDATE_BUNDLE_DIRECTORY"];

it.runIf(process.platform === "win32" && releaseBundles !== undefined)(
  "Windows release launchers preserve management results, replace their own program and remove their temporary runtime (built release bundles required)",
  () => {
    const h = host();
    const extraction = join(h.inputs, "unpacked bundle");
    const temporary = join(h.inputs, "management temp");
    mkdirSync(extraction);
    mkdirSync(temporary);
    const archive = (directory: string | undefined) => {
      expect(directory, "a directory of built release bundles").toBeDefined();
      const absolute = resolve(directory!);
      const matches = readdirSync(absolute).filter((name) =>
        name.endsWith(`-win-${process.arch}.tar.gz`),
      );
      expect(matches, "one release bundle for this host").toHaveLength(1);
      return join(absolute, matches[0]!);
    };
    const bundle = archive(releaseBundles);
    const update = archive(updateBundles);
    const unpacked = spawnSync("tar", ["-xzf", bundle, "-C", extraction], { encoding: "utf8" });
    expect(unpacked.status, unpacked.stderr).toBe(0);
    const env = {
      ...Object.fromEntries(
        Object.entries(h.env).filter(([name]) => !["TEMP", "TMP"].includes(name.toUpperCase())),
      ),
      TEMP: temporary,
      TMP: temporary,
    };
    const run = (launcher: string, ...args: string[]) => {
      const command = [launcher, "node", ...args].map((argument) => `"${argument}"`).join(" ");
      return spawnSync("cmd.exe", ["/d", "/s", "/c", `"${command}"`], {
        env,
        cwd: h.inputs,
        encoding: "utf8",
        windowsVerbatimArguments: true,
      });
    };
    const ok = (launcher: string, ...args: string[]) => {
      const result = run(launcher, ...args);
      expect(
        result.status,
        `${launcher} node ${args.join(" ")}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      ).toBe(0);
    };
    const launcher = join(extraction, "mate-node/bin/mate.cmd");
    const invalid = run(launcher, "update");
    expect(invalid.status, `${invalid.stdout}\n${invalid.stderr}`).toBe(2);
    expect(invalid.stderr).toContain("Usage:");
    expect(readdirSync(temporary), "failed management also removes its runtime").toEqual([]);

    const interactive = spawnSync("cmd.exe", ["/d", "/q"], {
      env,
      cwd: h.inputs,
      encoding: "utf8",
      input: `"${launcher}" node update\r\necho caller-still-running:%errorlevel%\r\nexit 0\r\n`,
    });
    expect(interactive.status, interactive.stderr).toBe(0);
    expect(interactive.stdout, "management leaves the caller's command prompt open").toContain(
      "caller-still-running:2",
    );
    expect(readdirSync(temporary), "interactive management removes its runtime").toEqual([]);

    ok(launcher, "install", bundle);
    const version = () =>
      JSON.parse(readFileSync(join(h.paths.program, "manifest.json"), "utf8")).version;
    const previous = version();
    ok(h.paths.command, "update", update);
    expect(version()).not.toBe(previous);
    expect(readdirSync(temporary), "update removes its management runtime").toEqual([]);

    ok(join(h.paths.program, "bin/mate.cmd"), "uninstall");
    for (const path of [h.paths.program, h.paths.command, h.paths.unit]) {
      expect(existsSync(path), `${path} is removed through the bundle's public entry`).toBe(false);
    }
    expect(readdirSync(temporary), "uninstall removes its management runtime").toEqual([]);
  },
  120_000,
);
