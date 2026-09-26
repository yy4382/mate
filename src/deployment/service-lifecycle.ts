export type CaddyMode = "managed" | "imported" | "external";
type Systemctl = (...args: string[]) => string;

interface ServiceState {
  active: boolean;
  enabled: boolean;
}

function status(systemctl: Systemctl, operation: string, unit: string): boolean {
  try {
    const value = systemctl(operation, unit);
    return operation === "is-active" ? value === "active" : value === "enabled";
  } catch {
    return false;
  }
}

/** A release switch owns process activation; restoring files alone cannot replace a live new process. */
export function transitionDualServices(
  systemctl: Systemctl,
  options: { upgrade: boolean; startNode: boolean; caddyMode: CaddyMode },
  prepare: () => void,
  publish: () => void,
  restore: () => void,
): void {
  const units = ["mate-control-plane.service", "mate-node.service", "caddy.service"] as const;
  const before = new Map<string, ServiceState>(
    units.map((unit) => [
      unit,
      {
        active: status(systemctl, "is-active", unit),
        enabled: status(systemctl, "is-enabled", unit),
      },
    ]),
  );
  let servicesChanged = false;
  let activationStarted = false;
  try {
    prepare();
    servicesChanged = true;
    if (options.upgrade) {
      systemctl("stop", "mate-node.service");
      systemctl("stop", "mate-control-plane.service");
    }
    publish();
    systemctl("daemon-reload");
    activationStarted = true;
    systemctl("enable", "mate-control-plane.service");
    systemctl("restart", "mate-control-plane.service");
    if (options.startNode) {
      systemctl("enable", "mate-node.service");
      systemctl("restart", "mate-node.service");
    }
    if (options.caddyMode === "managed") {
      systemctl("enable", "caddy.service");
      systemctl("reload-or-restart", "caddy.service");
    } else if (options.caddyMode === "imported" && before.get("caddy.service")?.active) {
      systemctl("reload-or-restart", "caddy.service");
    }
  } catch (original) {
    const rollbackErrors: unknown[] = [];
    const attempt = (action: () => void) => {
      try {
        action();
      } catch (error) {
        rollbackErrors.push(error);
      }
    };
    if (!servicesChanged) {
      attempt(restore);
      if (rollbackErrors.length)
        throw new AggregateError(
          [original, ...rollbackErrors],
          "Deployment preparation failed and rollback was incomplete",
        );
      throw original;
    }
    if (!options.upgrade && activationStarted)
      for (const unit of ["mate-node.service", "mate-control-plane.service"])
        for (const action of ["stop", "disable"]) attempt(() => systemctl(action, unit));
    attempt(restore);
    attempt(() => systemctl("daemon-reload"));
    for (const unit of units) {
      if (unit === "caddy.service" && options.caddyMode === "external") continue;
      if (!options.upgrade && unit !== "caddy.service") continue;
      const previous = before.get(unit)!;
      attempt(() => systemctl(previous.active ? "restart" : "stop", unit));
      attempt(() => systemctl(previous.enabled ? "enable" : "disable", unit));
    }
    if (rollbackErrors.length)
      throw new AggregateError(
        [original, ...rollbackErrors],
        "Deployment failed and rollback was incomplete",
      );
    throw original;
  }
}
