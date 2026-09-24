import type { MateConfig } from "../config.js";
import type { Principal } from "../domain/messages.js";
import { encode } from "../storage/store.js";

export function slackPrincipal(config: MateConfig, user?: string, bot?: string): Principal {
  const byUser = user ? config.agents.find((a) => a.slackUserId === user) : undefined;
  const byBot = bot ? config.agents.find((a) => a.slackBotId === bot) : undefined;
  if (user && bot && (byUser || byBot) && byUser?.id !== byBot?.id)
    throw new Error("Conflicting legacy author identities");
  const agent = byUser ?? byBot;
  if (agent) return { kind: "agent", id: agent.id };
  if (bot) return { kind: "external", id: encode(["slack", config.teamId, "bot", bot]) };
  if (user)
    return {
      kind: "human",
      id: config.principalIds?.[user] ?? encode(["slack", config.teamId, "user", user]),
    };
  return { kind: "unknown" };
}

/** Reverse only this adapter's stable mapping; never substitute another installation. */
export function slackUserForPrincipal(
  config: MateConfig,
  principal: Exclude<Principal, { kind: "unknown" }>,
): string {
  if (principal.kind === "agent") {
    const agent = config.agents.find((a) => a.id === principal.id);
    if (!agent) throw new Error("Agent has no Slack identity");
    return agent.slackUserId;
  }
  if (principal.kind !== "human") throw new Error("Principal does not belong to this adapter");
  const mapped = Object.entries(config.principalIds ?? {}).find(([, id]) => id === principal.id);
  if (mapped) return mapped[0];
  let parts: unknown;
  try {
    parts = JSON.parse(principal.id);
  } catch {
    throw new Error("Principal does not belong to this adapter");
  }
  if (
    !Array.isArray(parts) ||
    parts.length !== 4 ||
    parts[0] !== "slack" ||
    parts[1] !== config.teamId ||
    parts[2] !== "user" ||
    typeof parts[3] !== "string" ||
    !/^U[A-Z0-9]+$/.test(parts[3])
  )
    throw new Error("Principal does not belong to this adapter");
  const roundTrip = slackPrincipal(config, parts[3]);
  if (roundTrip.kind !== "human" || roundTrip.id !== principal.id)
    throw new Error("Principal identity mismatch");
  return parts[3];
}
