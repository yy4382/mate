import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import type { CaddyMode } from "./service-lifecycle.js";

export function caddyModeFor(caddyfile: string | null): CaddyMode {
  if (caddyfile === null || caddyfile.startsWith("# Mate managed Caddy site\n")) return "managed";
  return /^\s*import\s+["']?\/etc\/mate\/Caddyfile["']?(?:\s|$)/m.test(caddyfile)
    ? "imported"
    : "external";
}

const absolute = z.string().refine((value) => isAbsolute(value) && resolve(value) === value);
const origin = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    );
  });

/** Only boot locations and the first owner credential belong in deployment configuration. */
export const dualServiceConfigSchema = z
  .object({
    version: z.literal(1),
    publicOrigin: origin,
    controlPlanePort: z.number().int().min(1024).max(65535),
    controlPlaneDataDir: absolute,
    nodeDataDir: absolute,
    agentHomeRoot: absolute,
    ownerPasswordFile: absolute,
  })
  .strict()
  .refine((value) => {
    const paths = [value.controlPlaneDataDir, value.nodeDataDir, value.agentHomeRoot];
    return (
      paths.every((path) => /^\/var\/lib\/mate-[a-z-]+$/.test(path)) &&
      new Set(paths).size === paths.length &&
      value.ownerPasswordFile.startsWith("/etc/mate/")
    );
  }, "Mate data directories must be distinct /var/lib/mate-* paths");
export type DualServiceConfig = z.infer<typeof dualServiceConfigSchema>;

export function renderControlPlaneUnit(config: DualServiceConfig): string {
  return `[Unit]\nDescription=Mate control plane\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nUser=mate-control\nGroup=mate-control\nWorkingDirectory=/opt/mate/current\nEnvironment=MATE_CONTROL_PLANE_PORT=${config.controlPlanePort}\nEnvironment=MATE_CONTROL_PLANE_DATA_DIR=${config.controlPlaneDataDir}\nEnvironment=MATE_PUBLIC_ORIGIN=${config.publicOrigin}\nLoadCredential=owner-password:${config.ownerPasswordFile}\nExecStart=/usr/bin/env MATE_OWNER_PASSWORD_FILE=%d/owner-password /usr/bin/node /opt/mate/current/dist/src/control-plane/main.js\nRestart=on-failure\nRestartSec=5\nUMask=0077\nNoNewPrivileges=true\nProtectSystem=strict\nReadWritePaths=${config.controlPlaneDataDir}\nPrivateTmp=true\nMemoryMax=512M\n\n[Install]\nWantedBy=multi-user.target\n`;
}

export function renderNodeUnit(config: DualServiceConfig): string {
  return `[Unit]\nDescription=Mate Linux node\nAfter=network-online.target mate-control-plane.service\nWants=network-online.target\nRequires=mate-control-plane.service\n\n[Service]\nType=simple\nUser=root\nGroup=root\nWorkingDirectory=/opt/mate/current\nEnvironment=MATE_CONTROL_PLANE_URL=ws://127.0.0.1:${config.controlPlanePort}\nEnvironment=MATE_NODE_DATA_DIR=${config.nodeDataDir}\nEnvironment=MATE_NODE_AGENT_HOME_ROOT=${config.agentHomeRoot}\nEnvironmentFile=-/etc/mate/node.env\nExecStart=/usr/bin/node /opt/mate/current/dist/src/node/main.js\nRestart=on-failure\nRestartSec=5\nUMask=0077\nMemoryMax=768M\n\n[Install]\nWantedBy=multi-user.target\n`;
}

export function renderCaddy(config: DualServiceConfig): string {
  return `# Mate managed Caddy site\n${new URL(config.publicOrigin).hostname} {\n  reverse_proxy 127.0.0.1:${config.controlPlanePort}\n  encode zstd gzip\n}\n`;
}
