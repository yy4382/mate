import { expect, it } from "vitest";
import { stopForCoordinatedMaintenance } from "../../src/deployment/coordinated-stop.js";

it("stops node, Agent scopes and control plane before allowing a checkpoint", () => {
  const calls: string[] = [];
  const host = {
    platform: "linux" as const,
    euid: () => 0,
    run: (_binary: string, args: readonly string[]) => {
      calls.push(args.join(" "));
      if (args[0] === "list-units" && args.includes("--state=active"))
        return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "list-units")
        return {
          code: 0,
          stdout:
            "mate-agent-24001-11111111-1111-4111-8111-111111111111.scope loaded active running Agent\n",
          stderr: "",
        };
      if (args[0] === "show" && args.includes("ActiveState"))
        return { code: 0, stdout: "inactive\n", stderr: "" };
      if (args[0] === "show" && args.includes("ControlGroup"))
        return {
          code: 0,
          stdout: "/system.slice/mate-agent-24001-11111111-1111-4111-8111-111111111111.scope\n",
          stderr: "",
        };
      return { code: 0, stdout: "", stderr: "" };
    },
    processes: { pids: () => [], uid: () => undefined },
  };
  stopForCoordinatedMaintenance(host);
  expect(calls.filter((call) => call.startsWith("stop "))).toEqual([
    "stop mate-node.service",
    "stop mate-agent-24001-11111111-1111-4111-8111-111111111111.scope",
    "stop mate-control-plane.service",
  ]);
});

it("refuses to publish a checkpoint while an Agent process survives the stop", () => {
  const host = {
    platform: "linux" as const,
    euid: () => 0,
    run: (_binary: string, args: readonly string[]) => {
      if (args[0] === "show" && args.includes("ActiveState"))
        return { code: 0, stdout: "inactive\n", stderr: "" };
      if (args[0] === "list-units" && args.includes("--state=active"))
        return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "list-units")
        return {
          code: 0,
          stdout:
            "mate-agent-24001-11111111-1111-4111-8111-111111111111.scope loaded active running Agent\n",
          stderr: "",
        };
      if (args[0] === "show" && args.includes("ControlGroup"))
        return {
          code: 0,
          stdout: "/system.slice/mate-agent-24001-11111111-1111-4111-8111-111111111111.scope\n",
          stderr: "",
        };
      return { code: 0, stdout: "", stderr: "" };
    },
    processes: { pids: () => [4123], uid: () => 24001 },
  };
  expect(() => stopForCoordinatedMaintenance(host)).toThrow(/Agent process.*running/);
});
