import { mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { lstatOrUndefined, writeServiceFile } from "./service-files.ts";
import type { BundleLayout, Launcher, Layout, Ownership } from "./types.ts";

export function posixLauncher(bundle: BundleLayout): Launcher {
  const target = (paths: Layout) => join(paths.program, bundle.command);
  const ownership = (paths: Layout): Ownership => {
    const stat = lstatOrUndefined(paths.command);
    if (stat === undefined) return "absent";
    return stat.isSymbolicLink() && readlinkSync(paths.command) === target(paths)
      ? "mate"
      : "foreign";
  };
  return {
    ownership,
    install(paths) {
      switch (ownership(paths)) {
        case "absent":
          mkdirSync(dirname(paths.command), { recursive: true });
          symlinkSync(target(paths), paths.command);
          return [`Linked ${paths.command} to ${target(paths)}.`];
        case "foreign":
          return [
            `Left ${paths.command} alone: it is not Mate's link. Run ${target(paths)} instead.`,
          ];
        case "mate":
          return [];
      }
    },
    remove(paths) {
      switch (ownership(paths)) {
        case "mate":
          unlinkSync(paths.command);
          return [`Removed ${paths.command}.`];
        case "foreign":
          return [`Left ${paths.command} alone: it is not Mate's link.`];
        case "absent":
          return [];
      }
    },
  };
}

export function windowsLauncher(bundle: BundleLayout): Launcher {
  const header = "@echo off\r\nrem Written by mate node.\r\n";
  const content = (paths: Layout) => {
    const program = relative(dirname(paths.command), paths.program).replaceAll("%", "%%");
    const command = bundle.command.replaceAll("/", "\\");
    return `${header}"%~dp0${program}\\${command}" %*\r\n`;
  };
  const ownership = (paths: Layout): Ownership => {
    const stat = lstatOrUndefined(paths.command);
    if (stat === undefined) return "absent";
    return stat.isFile() && readFileSync(paths.command, "utf8").startsWith(header)
      ? "mate"
      : "foreign";
  };
  return {
    ownership,
    install(paths) {
      switch (ownership(paths)) {
        case "absent":
          writeServiceFile(paths.command, content(paths));
          return [
            `Wrote ${paths.command}. Add ${dirname(paths.command)} to your user PATH to run mate.`,
          ];
        case "foreign":
          return [
            `Left ${paths.command} alone: Mate did not write it. Run ${join(paths.program, bundle.command)} instead.`,
          ];
        case "mate":
          return writeServiceFile(paths.command, content(paths))
            ? [`Updated ${paths.command}.`]
            : [];
      }
    },
    remove(paths) {
      switch (ownership(paths)) {
        case "mate":
          unlinkSync(paths.command);
          return [`Removed ${paths.command}.`];
        case "foreign":
          return [`Left ${paths.command} alone: Mate did not write it.`];
        case "absent":
          return [];
      }
    },
  };
}
