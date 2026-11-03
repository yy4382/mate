import { homedir } from "node:os";
import { join } from "node:path";
import type { Layout } from "./types.ts";

export function linuxLayout(home = homedir()): Layout {
  return {
    program: join(home, ".local/lib/palace-node"),
    command: join(home, ".local/bin/palace"),
    unit: join(home, ".config/systemd/user/palace-node.service"),
    config: join(home, ".config/palace/node.json"),
    data: join(home, ".local/share/palace/node"),
    workspaces: join(home, "palace/workspaces"),
  };
}

export function darwinLayout(home = homedir()): Layout {
  return {
    ...linuxLayout(home),
    unit: join(home, "Library/LaunchAgents/io.palace.node.plist"),
  };
}

export function windowsLayout(home = homedir(), env = process.env): Layout {
  const localAppData = env["LOCALAPPDATA"];
  if (localAppData === undefined || localAppData.length === 0) {
    throw new Error("LOCALAPPDATA is missing; run Palace as a signed-in Windows account.");
  }
  const root = join(localAppData, "Palace");
  return {
    program: join(root, "program"),
    command: join(root, "bin/palace.cmd"),
    unit: join(root, "config/node-task.xml"),
    config: join(root, "config/node.json"),
    data: join(root, "data"),
    workspaces: join(home, "palace/workspaces"),
  };
}
