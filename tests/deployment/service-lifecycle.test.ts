import { expect, it } from "vitest";
import { transitionDualServices } from "../../src/deployment/service-lifecycle.js";

it.each(["mate-node.service", "caddy.service"])(
  "restores the old running release when %s fails after the new control plane starts",
  (failedUnit) => {
    const calls: string[] = [];
    let release = "old";
    const systemctl = (...args: string[]) => {
      const operation = args.join(" ");
      calls.push(`${release}:${operation}`);
      if (args[0] === "is-active" || args[0] === "is-enabled") return "active";
      if (release === "new" && args[0] === "restart" && args[1] === failedUnit)
        throw new Error("injected start failure");
      if (release === "new" && args[0] === "reload-or-restart" && args[1] === failedUnit)
        throw new Error("injected reload failure");
      return "";
    };
    expect(() =>
      transitionDualServices(
        systemctl,
        { upgrade: true, startNode: true, caddyMode: "managed" },
        () => {},
        () => {
          release = "new";
        },
        () => {
          release = "old";
        },
      ),
    ).toThrow("injected");
    expect(release).toBe("old");
    expect(calls).toContain("old:restart mate-control-plane.service");
    expect(calls).toContain("old:restart mate-node.service");
  },
);

it("stops and disables services that a failed first install started", () => {
  const calls: string[] = [];
  let installed = false;
  const systemctl = (...args: string[]) => {
    calls.push(args.join(" "));
    if (args[0] === "is-active" || args[0] === "is-enabled") throw new Error("not installed");
    if (!installed && ["stop", "disable"].includes(args[0]!) && args[1] !== "caddy.service")
      throw new Error("unit file already removed");
    if (args[0] === "restart" && args[1] === "mate-node.service") throw new Error("node failed");
    return "";
  };
  expect(() =>
    transitionDualServices(
      systemctl,
      { upgrade: false, startNode: true, caddyMode: "managed" },
      () => {},
      () => {
        installed = true;
      },
      () => {
        installed = false;
      },
    ),
  ).toThrow("node failed");
  expect(calls).toContain("stop mate-control-plane.service");
  expect(calls).toContain("disable mate-control-plane.service");
  expect(calls).toContain("stop mate-node.service");
  expect(calls).toContain("disable mate-node.service");
});

it("reloads an operator-managed Caddy site that imports Mate's generated site", () => {
  const calls: string[] = [];
  transitionDualServices(
    (...args) => {
      calls.push(args.join(" "));
      return "active";
    },
    { upgrade: true, startNode: false, caddyMode: "imported" },
    () => {},
    () => {},
    () => {},
  );
  expect(calls).toContain("reload-or-restart caddy.service");
});
