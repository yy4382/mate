import { readFileSync } from "node:fs";
const cut = JSON.parse(readFileSync(process.argv[2], "utf8"));
for (const pid of [...cut.children, cut.pid]) {
  try {
    process.kill(pid, "SIGKILL");
  } catch (e) {
    if (e.code !== "ESRCH") throw e;
  }
}
