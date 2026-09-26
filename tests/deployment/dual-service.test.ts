import { expect, it } from "vitest";
import {
  dualServiceConfigSchema,
  renderCaddy,
  renderControlPlaneUnit,
  renderNodeUnit,
  caddyModeFor,
} from "../../src/deployment/dual-service.js";

const config = dualServiceConfigSchema.parse({
  version: 1,
  publicOrigin: "https://mate.example.org",
  controlPlanePort: 8787,
  controlPlaneDataDir: "/var/lib/mate-control-plane",
  nodeDataDir: "/var/lib/mate-node",
  agentHomeRoot: "/var/lib/mate-agents",
  ownerPasswordFile: "/etc/mate/owner-password",
});

it("renders two separate service identities and one TLS reverse proxy", () => {
  expect(renderControlPlaneUnit(config)).toContain("User=mate-control");
  expect(renderControlPlaneUnit(config)).toContain("Type=notify\nNotifyAccess=all");
  expect(renderControlPlaneUnit(config)).toContain("MATE_CONTROL_PLANE_PORT=8787");
  expect(renderControlPlaneUnit(config)).not.toContain("User=root");
  expect(renderNodeUnit(config)).toContain("User=root");
  expect(renderNodeUnit(config)).toContain("Type=notify\nNotifyAccess=all");
  expect(renderNodeUnit(config)).toContain("MATE_CONTROL_PLANE_URL=ws://127.0.0.1:8787");
  expect(renderCaddy(config)).toContain("mate.example.org {\n  reverse_proxy 127.0.0.1:8787");
});

it("rejects a public HTTP origin and relative private data directories", () => {
  expect(() =>
    dualServiceConfigSchema.parse({ ...config, publicOrigin: "http://mate.example.org" }),
  ).toThrow();
  expect(() => dualServiceConfigSchema.parse({ ...config, nodeDataDir: "node-data" })).toThrow();
});

it("recognizes an existing Caddyfile importing Mate's generated site", () => {
  expect(caddyModeFor("example.org {\n  import /etc/mate/Caddyfile\n}\n")).toBe("imported");
  expect(caddyModeFor("example.org {\n  reverse_proxy 127.0.0.1:8787\n}\n")).toBe("external");
  expect(caddyModeFor(null)).toBe("managed");
});
