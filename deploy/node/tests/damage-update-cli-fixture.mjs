import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const dir = process.argv[2],
  file = "app/apps/node/dist/management/cli.js";
writeFileSync(`${dir}/${file}`, 'throw new Error("synthetic new CLI preflight failure");\n');
const metadata = JSON.parse(readFileSync(`${dir}/bundle.json`, "utf8"));
metadata.files.find((entry) => entry.path === file).sha256 = createHash("sha256")
  .update(readFileSync(`${dir}/${file}`))
  .digest("hex");
writeFileSync(`${dir}/bundle.json`, JSON.stringify(metadata, null, 2) + "\n");
