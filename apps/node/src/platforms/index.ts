import { bundleLayouts } from "./bundle-layout.ts";
import { launchd } from "./launchd.ts";
import { posixLauncher, windowsLauncher } from "./launcher.ts";
import { darwinLayout, linuxLayout, windowsLayout } from "./layout.ts";
import { scheduler } from "./scheduler.ts";
import { posixCommands, windowsCommands } from "./shells.ts";
import { systemd } from "./systemd.ts";
import type { Platform, PlatformId } from "./types.ts";
import { posixWorkspacePaths, windowsWorkspacePaths } from "./workspace-paths.ts";

export const platforms: Record<PlatformId, Platform> = {
  linux: {
    layout: linuxLayout,
    commands: posixCommands,
    service: (paths) => systemd(paths, bundleLayouts.linux),
    launcher: posixLauncher(bundleLayouts.linux),
    checkIdentityMode: true,
    workspacePaths: posixWorkspacePaths,
  },
  darwin: {
    layout: darwinLayout,
    commands: posixCommands,
    service: (paths) => launchd(paths, bundleLayouts.darwin),
    launcher: posixLauncher(bundleLayouts.darwin),
    checkIdentityMode: true,
    workspacePaths: posixWorkspacePaths,
  },
  win32: {
    layout: windowsLayout,
    commands: windowsCommands,
    service: (paths) => scheduler(paths, bundleLayouts.win32),
    launcher: windowsLauncher(bundleLayouts.win32),
    checkIdentityMode: false,
    workspacePaths: windowsWorkspacePaths,
  },
};

export function currentPlatform(): Platform {
  const platform = platforms[process.platform as PlatformId];
  if (platform === undefined) throw new Error(`Mate node does not support ${process.platform}`);
  return platform;
}
