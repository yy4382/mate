import { describe, expect, it } from "vitest";
import { host, snapshot, writeBundle, type TarEntry } from "./cli-support.ts";

describe("mate node install and update check the bundle (MODULE_TESTS 9)", () => {
  const file = (path: string): TarEntry => ({ path, type: "file", content: "x" });
  const regularFiles =
    process.platform === "win32"
      ? ["bin/mate.cmd", "node/node.exe", "lib/mate.mjs"]
      : ["bin/mate", "node/bin/node", "lib/mate.mjs"];
  it.each<[string, Parameters<typeof writeBundle>[1]]>([
    ["does not match its checksum", { version: "2.0.0", checksum: "wrong" }],
    ["has no checksum file", { version: "2.0.0", checksum: "missing" }],
    [
      "holds a symbolic link",
      { version: "2.0.0", extra: [{ path: "mate-node/lib/x", type: "symlink", target: "/etc" }] },
    ],
    [
      "holds a hard link",
      {
        version: "2.0.0",
        extra: [{ path: "mate-node/lib/x", type: "hardlink", target: "mate-node/bin/mate" }],
      },
    ],
    [
      "holds a special file",
      { version: "2.0.0", extra: [{ path: "mate-node/lib/x", type: "fifo" }] },
    ],
    ["holds a path with ..", { version: "2.0.0", extra: [file("mate-node/../../escaped")] }],
    ["holds an absolute path", { version: "2.0.0", extra: [file("/tmp/escaped")] }],
    ["holds a path outside mate-node/", { version: "2.0.0", extra: [file("other/escaped")] }],
    [
      "holds a file its manifest does not list",
      { version: "2.0.0", extra: [file("mate-node/lib/x")] },
    ],
    [
      "lacks a file its manifest lists",
      { version: "2.0.0", listed: [...regularFiles, "lib/gone.mjs"] },
    ],
    [
      "was built for another platform",
      { version: "2.0.0", platform: process.platform === "linux" ? "darwin" : "linux" },
    ],
    [
      "was built for another architecture",
      { version: "2.0.0", arch: process.arch === "x64" ? "arm64" : "x64" },
    ],
  ])("a bundle that %s is rejected without changing anything installed", (_, options) => {
    const h = host();
    const installed = h.mate("node", "install", writeBundle(h.inputs, { version: "1.0.0" }));
    expect(installed.status, installed.stderr).toBe(0);
    const before = snapshot(h.home);
    const updated = h.mate("node", "update", writeBundle(h.inputs, options));
    expect(updated.status, updated.stderr).toBe(1);
    expect(snapshot(h.home)).toEqual(before);

    const fresh = host();
    expect(fresh.mate("node", "install", writeBundle(fresh.inputs, options)).status).toBe(1);
    expect(
      snapshot(fresh.home).filter((line) => !/\/ \d+$/.test(line)),
      "a first install leaves no file behind",
    ).toEqual([]);
  });
});
