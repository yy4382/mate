import { homedir } from "node:os";
import { join } from "node:path";
import type { Layout } from "./types.ts";

export function linuxLayout(home = homedir()): Layout {
  return {
    program: join(home, ".local/lib/mate-node"),
    command: join(home, ".local/bin/mate"),
    unit: join(home, ".config/systemd/user/mate-node.service"),
    config: join(home, ".config/mate/node.json"),
    data: join(home, ".local/share/mate/node"),
    workspaces: join(home, "mate/workspaces"),
  };
}

export function darwinLayout(home = homedir()): Layout {
  return {
    ...linuxLayout(home),
    unit: join(home, "Library/LaunchAgents/io.mate.node.plist"),
  };
}

export function windowsLayout(home = homedir(), env = process.env): Layout {
  const localAppData = env["LOCALAPPDATA"];
  if (localAppData === undefined || localAppData.length === 0) {
    throw new Error("LOCALAPPDATA is missing; run Mate as a signed-in Windows account.");
  }
  const root = join(localAppData, "Mate");
  return {
    program: join(root, "program"),
    command: join(root, "bin/mate.cmd"),
    unit: join(root, "config/node-task.xml"),
    config: join(root, "config/node.json"),
    data: join(root, "data"),
    workspaces: join(home, "mate/workspaces"),
  };
}
