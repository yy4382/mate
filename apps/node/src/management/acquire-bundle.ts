import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { releaseVersion, withoutDownloadCredentials } from "./bundle.js";

export const bundleRequest = z
  .object({
    version: releaseVersion,
    package: z.string().min(1).optional(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict()
  .refine(
    (value) => Boolean(value.package) === Boolean(value.sha256),
    "Local packages require --package and --sha256 together",
  );

function tar(args: string[]) {
  const result = spawnSync("/usr/bin/tar", args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120_000,
    env: { ...withoutDownloadCredentials(process.env), LC_ALL: "C" },
  });
  if (result.status !== 0) throw new Error("Invalid package archive or extraction failed");
  return result.stdout;
}

/** Acquires into a temporary directory only; the caller owns all installed changes. */
export async function withReleaseBundle<T>(
  request: z.input<typeof bundleRequest>,
  action: (directory: string) => T,
) {
  const selected = bundleRequest.parse(request);
  if (!["x64", "arm64"].includes(process.arch))
    throw new Error("Only Linux x64 and arm64 bundles are supported");
  const asset = `mate-node-${selected.version}-linux-${process.arch}.tar.gz`;
  const temporary = mkdtempSync(join(tmpdir(), "mate-node-package-"));
  try {
    const archive = join(temporary, asset);
    let checksum = selected.sha256;
    if (selected.package) copyFileSync(resolve(selected.package), archive);
    else {
      if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN)
        throw new Error(
          "Supply a temporary GH_TOKEN for this private release download, or a local package and SHA-256",
        );
      // Credentials belong only to the downloader. Never forward its potentially sensitive diagnostics.
      const download = spawnSync(
        "gh",
        [
          "release",
          "download",
          `v${selected.version}`,
          "--repo",
          "yy4382/mate",
          "--pattern",
          asset,
          "--pattern",
          "SHA256SUMS",
          "--dir",
          temporary,
        ],
        {
          stdio: "ignore",
          timeout: 120_000,
        },
      );
      if (download.status !== 0)
        throw new Error(
          "Private release download failed; check the explicit version and temporary authentication",
        );
      const matches = readFileSync(join(temporary, "SHA256SUMS"), "utf8")
        .split("\n")
        .map((line) => line.trim().split(/\s+/))
        .filter((fields) => fields[1] === asset);
      if (matches.length !== 1)
        throw new Error("Release checksums do not uniquely identify the selected package");
      checksum = matches[0]?.[0];
    }
    if (!checksum || !/^[a-f0-9]{64}$/.test(checksum))
      throw new Error("Invalid release SHA-256 value");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    if (hash.digest("hex") !== checksum) throw new Error("Package SHA-256 mismatch");
    const names = tar([
      "--list",
      "--gzip",
      "--absolute-names",
      "--quoting-style=escape",
      "--file",
      archive,
    ])
      .trimEnd()
      .split("\n");
    if (
      !names.length ||
      names.some(
        (name) =>
          !name.startsWith("mate-node/") ||
          /[\\\x00-\x1f]/.test(name) ||
          name.split("/").some((part) => part === "." || part === ".."),
      )
    )
      throw new Error("Unsafe package archive path");
    const modes = tar(["--list", "--verbose", "--gzip", "--file", archive]).trimEnd().split("\n");
    if (modes.some((line) => !["-", "d"].includes(line[0] ?? "")))
      throw new Error("Package links or special files are forbidden");
    const unpacked = join(temporary, "unpacked");
    mkdirSync(unpacked, { mode: 0o700 });
    tar([
      "--extract",
      "--gzip",
      "--file",
      archive,
      "--directory",
      unpacked,
      "--no-same-owner",
      "--no-same-permissions",
    ]);
    return await action(join(unpacked, "mate-node"));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
