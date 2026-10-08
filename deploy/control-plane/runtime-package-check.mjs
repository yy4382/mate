import { accessSync, existsSync, readdirSync, realpathSync, lstatSync } from "node:fs";
import { join } from "node:path";

if (existsSync("src") || existsSync("tests"))
  throw new Error("Source/tests entered the delivery package");
for (const path of ["/usr/local/bin/pnpm", "/usr/local/bin/npm", "/usr/bin/g++", "/usr/bin/make"])
  if (existsSync(path)) throw new Error(`Build tool in runtime: ${path}`);

function inspectDependencies(path) {
  for (const name of readdirSync(path)) {
    const file = join(path, name);
    const state = lstatSync(file);
    if (state.isSymbolicLink() && !realpathSync(file).startsWith("/opt/mate/"))
      throw new Error(`Dependency outside delivery: ${file}`);
    if (state.isDirectory()) inspectDependencies(file);
  }
}
inspectDependencies("/opt/mate");

const { webRoot } = await import("@mate/web/assets");
accessSync(join(webRoot, "index.html"));
accessSync(join(webRoot, "manifest.webmanifest"));
await import("better-sqlite3");
await import("argon2");
