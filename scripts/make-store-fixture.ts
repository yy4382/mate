// Builds a store fixture: the data directory a released version of Mate writes, so a test can prove the current code
// upgrades it in place.
//
// usage: node scripts/make-store-fixture.ts <git-ref> <out-dir>
//
// It checks the ref out in a throwaway worktree under the OS temp directory, installs that version's dependencies,
// runs `store-fixture/populate.ts` there against that version's own packages, and copies the resulting data directory
// to <out-dir> (replacing what was there). The worktree is removed afterwards, also when a step fails.
import { spawnSync } from "node:child_process";
import {
  cpSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [ref, outArgument] = process.argv.slice(2);
if (ref === undefined || outArgument === undefined) {
  console.error("usage: node scripts/make-store-fixture.ts <git-ref> <out-dir>");
  process.exit(2);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(outArgument);

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed (${result.status})`);
  return result.stdout;
}

const scratch = mkdtempSync(join(tmpdir(), "mate-store-fixture-"));
const checkout = join(scratch, "checkout");
let added = false;
try {
  const commit = run("git", ["rev-parse", "--verify", `${ref}^{commit}`], root).trim();
  run("git", ["worktree", "add", "--detach", checkout, commit], root);
  added = true;
  run("pnpm", ["install", "--frozen-lockfile"], checkout);

  const home = join(checkout, "apps", "control-plane");
  copyFileSync(
    join(root, "scripts", "store-fixture", "populate.ts"),
    join(home, "populate-store-fixture.ts"),
  );
  const data = join(scratch, "data-directory");
  const factsFile = join(scratch, "facts.json");
  run("node", ["--conditions=mate-source", "populate-store-fixture.ts", data, factsFile], home);

  const leftovers = readdirSync(data).filter(
    (name) => name.endsWith("-wal") || name.endsWith("-shm"),
  );
  if (leftovers.length > 0)
    throw new Error(`the stores were not closed cleanly: ${leftovers.join(", ")}`);

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(data, join(out, "data-directory"), { recursive: true });
  copyFileSync(factsFile, join(out, "facts.json"));
  const facts = JSON.parse(readFileSync(factsFile, "utf8")) as { ownerPassword: string };
  writeFileSync(
    join(out, "README.md"),
    `# Store fixture: ${ref}

The data directory (\`data-directory/\`) that Mate at \`${ref}\` (commit \`${commit}\`) writes, built through that
version's own public module APIs. Tests copy it and start the current code on the copy.

Regenerate with \`node scripts/make-store-fixture.ts ${ref} ${out.startsWith(root) ? out.slice(root.length + 1) : out}\`.

It is test data, not a secret. The owner logs in with the password \`${facts.ownerPassword}\`. \`facts.json\` holds that
password and the other values the tests check.
`,
  );
} finally {
  if (added) spawnSync("git", ["worktree", "remove", "--force", checkout], { cwd: root });
  rmSync(scratch, { recursive: true, force: true });
}
