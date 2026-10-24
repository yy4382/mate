const fs = require("node:fs");
const path = require("node:path");
const file = process.env.MATE_FAKE_SERVICE_STATE;
const paths = JSON.parse(process.env.MATE_FAKE_SERVICE_PATHS);
const state = JSON.parse(fs.readFileSync(file, "utf8"));
const tool = process.argv[2];
const args = process.argv.slice(3);
function exit(code) {
  fs.writeFileSync(file, JSON.stringify(state));
  process.exit(code);
}
function print(value) {
  process.stdout.write(value + "\n");
}
state.calls.push([tool, ...args]);
if (!state.available) {
  console.error("user manager is unavailable");
  exit(1);
}
const hasUnit = fs.existsSync(paths.unit);
if (tool === "systemctl") {
  const [scope, verb, ...rest] = args;
  if (scope !== "--user") exit(1);
  if (verb === "show") {
    print("LoadState=" + (hasUnit ? "loaded" : "not-found"));
    print("ActiveState=" + state.active);
    print("UnitFileState=" + (hasUnit ? state.enabled : ""));
    print("MainPID=" + state.mainPid);
    print("FragmentPath=" + (state.foreignDefinition ? "/other.service" : paths.unit));
  } else if (verb === "enable" && hasUnit) {
    state.enabled = "enabled";
    if (rest.includes("--now")) state.active = "active";
  } else if (verb === "disable") {
    state.enabled = "disabled";
    if (rest.includes("--now")) state.active = "inactive";
  } else if (verb !== "daemon-reload") exit(1);
} else if (tool === "launchctl") {
  const [verb, target] = args;
  if (verb === "print-disabled") {
    print('{ "io.mate.node" => ' + (state.enabled === "enabled" ? "false" : "true") + " }");
  } else if (verb === "print" && target.split("/").length === 2) {
    print(target + " = {}");
  } else if (verb === "print") {
    if (!state.loaded) exit(113);
    const names = {
      active: "running",
      inactive: "waiting",
      failed: "waiting",
      activating: "starting",
      deactivating: "terminating",
      reloading: "running",
    };
    print("path = " + (state.foreignDefinition ? "/other.plist" : paths.unit));
    print("state = " + (names[state.active] || "unrecognized"));
    if (state.active === "active" || state.active === "reloading")
      print("pid = " + (state.mainPid || 99999));
  } else if (verb === "enable") state.enabled = "enabled";
  else if (verb === "disable") state.enabled = "disabled";
  else if (verb === "bootstrap" || verb === "kickstart") {
    state.loaded = true;
    state.active = "active";
  } else if (verb === "bootout") {
    state.loaded = false;
    state.active = "inactive";
  } else exit(1);
} else if (tool === "powershell") {
  if (args.at(-1).includes("Get-Content")) {
    state.journal.push(args);
    print("a journal line");
  } else {
    const sid = "S-1-5-21-12345";
    const runtime = path.join(paths.program, "node/node.exe");
    const states = {
      active: 4,
      inactive: 1,
      failed: 1,
      activating: 2,
      deactivating: 0,
      reloading: 4,
    };
    const pid = state.mainPid || 99999;
    const task = !state.loaded
      ? null
      : {
          state: states[state.active] ?? 0,
          enabled: state.enabled === "enabled",
          description: state.foreignDefinition ? "Someone else's task" : "Written by mate node.",
          instances: state.active === "active" ? [pid] : [],
        };
    const processes =
      state.active !== "active"
        ? []
        : [
            {
              pid,
              parent: 1,
              executable: state.unverifiedProcess ? "C:\\unrelated.exe" : runtime,
              created: state.created ?? "2000-01-01T00:00:00.000Z",
            },
          ];
    print(JSON.stringify({ name: "Mate node " + sid, sid, task, processes }));
  }
} else if (tool === "schtasks") {
  const verb = args[0];
  if (verb === "/Create") {
    state.loaded = true;
    state.active = "inactive";
    state.enabled = "disabled";
  } else if (verb === "/Delete") {
    state.loaded = false;
    state.active = "inactive";
  } else if (verb === "/Run") state.active = "active";
  else if (verb === "/End") state.active = "inactive";
  else if (verb === "/Change") state.enabled = args.includes("/ENABLE") ? "enabled" : "disabled";
  else exit(1);
} else if (tool === "taskkill") {
  state.active = "inactive";
  state.mainPid = 0;
} else if (tool === "journalctl" || tool === "tail") {
  state.journal.push(args);
  print("a journal line");
} else exit(1);
exit(0);
