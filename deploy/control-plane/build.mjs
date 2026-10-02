import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const version = process.argv[2];
if (!version || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9][a-zA-Z0-9.-]*)?$/.test(version))
  throw new Error("Usage: pnpm build:image:control-plane <explicit-version> [image-tag]");
const image = process.argv[3] ?? `mate-control-plane:${version}`;
const root = fileURLToPath(new URL("../../", import.meta.url));
const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
if (revision.status !== 0) throw new Error("Cannot determine the tested checkout revision");
const build = spawnSync(
  "docker",
  [
    "build",
    "--file",
    "deploy/control-plane/Dockerfile",
    "--build-arg",
    `MATE_VERSION=${version}`,
    "--build-arg",
    `MATE_REVISION=${revision.stdout.trim()}`,
    "--tag",
    image,
    ".",
  ],
  { cwd: root, stdio: "inherit" },
);
if (build.error) throw build.error;
process.exitCode = build.status ?? 1;
