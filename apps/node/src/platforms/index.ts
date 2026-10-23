import { bundleLayouts } from "./bundle-layout.ts";
import { launchd } from "./launchd.ts";
import { posixLauncher, windowsLauncher } from "./launcher.ts";
import { darwinLayout, linuxLayout, windowsLayout } from "./layout.ts";
import { posixPrivateFiles, windowsPrivateFiles } from "./private-files.ts";
import { scheduler } from "./scheduler.ts";
import { darwinCommands, linuxCommands, windowsCommands } from "./shells.ts";
import { systemd } from "./systemd.ts";
import type { Platform, PlatformId } from "./types.ts";
import { posixWorkspacePaths, windowsWorkspacePaths } from "./workspace-paths.ts";

export const platforms: Record<PlatformId, Platform> = {
  linux: {
    id: "linux",
    bundle: bundleLayouts.linux,
    layout: linuxLayout,
    commands: linuxCommands,
    service: (paths) => systemd(paths, bundleLayouts.linux),
    launcher: posixLauncher(bundleLayouts.linux),
    privateFiles: posixPrivateFiles,
    workspacePaths: posixWorkspacePaths,
  },
  darwin: {
    id: "darwin",
    bundle: bundleLayouts.darwin,
    layout: darwinLayout,
    commands: darwinCommands,
    service: (paths) => launchd(paths, bundleLayouts.darwin),
    launcher: posixLauncher(bundleLayouts.darwin),
    privateFiles: posixPrivateFiles,
    workspacePaths: posixWorkspacePaths,
  },
  win32: {
    id: "win32",
    bundle: bundleLayouts.win32,
    layout: windowsLayout,
    commands: windowsCommands,
    service: (paths) => scheduler(paths, bundleLayouts.win32),
    launcher: windowsLauncher(bundleLayouts.win32),
    privateFiles: windowsPrivateFiles,
    workspacePaths: windowsWorkspacePaths,
  },
};

export function currentPlatform(): Platform {
  const platform = platforms[process.platform as PlatformId];
  if (platform === undefined) throw new Error(`Mate node does not support ${process.platform}`);
  return platform;
}
