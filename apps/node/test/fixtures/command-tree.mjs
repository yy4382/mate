import { spawn } from "node:child_process";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

const [name, level = "root"] = process.argv.slice(2);
const script = fileURLToPath(import.meta.url);
const next = { root: "child", child: "grandchild" }[level];
const descendants = [];
let child;
const heartbeat = setInterval(() => {}, 1000);

if (next !== undefined) {
  child = spawn(process.execPath, [script, name, next], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  child.on("message", (pids) => {
    descendants.push(...pids);
    ready();
  });
} else {
  ready();
}

function ready() {
  const pids = [process.pid, ...descendants];
  if (level === "root") {
    writeFileSync(`${name}.tmp`, pids.join(" "));
    renameSync(`${name}.tmp`, `${name}.pids`);
    process.stdout.write("waiting\n");
    const poll = setInterval(() => {
      if (!existsSync(`${name}.go`)) return;
      clearInterval(poll);
      finish();
    }, 20);
  } else {
    process.send(pids);
  }
}

process.on("message", finish);

function finish() {
  clearInterval(heartbeat);
  if (child === undefined) {
    process.exit(0);
  } else {
    child.once("exit", () => {
      if (level === "root") process.stdout.write(`done in ${basename(process.cwd())}\n`);
      process.exit(0);
    });
    child.send("finish");
  }
}
