import type { SlackService, SlackServiceTarget } from "../../src/slack/service.js";

/**
 * Whole-scope maintenance for suites that assert "every channel this installation remembers".
 *
 * The connection runtime confirms membership and recovers history target by target, so no single
 * unfinished channel can hold back the installation. A suite that wants the old all-at-once answer
 * asks for the same per-target work here, over the channels an installation currently remembers as
 * active plus the channels its configuration names — the set the aggregate used to cover.
 */
function installation(service: SlackService, agentId: string) {
  const agent = service.transport.mapper.config.agents.find((entry) => entry.id === agentId);
  if (!agent) throw new Error(`Unknown Slack installation: ${agentId}`);
  return agent;
}
export function rememberedChannels(service: SlackService, agentId: string): SlackServiceTarget[] {
  const agent = installation(service, agentId),
    m = service.c.messages,
    team = service.transport.mapper.config.teamId,
    stored = service.c.store.db
      .prepare(
        "SELECT a.channel FROM channel_access a JOIN conversation_bindings b ON b.conversation_id=a.channel WHERE b.provider='slack' AND b.mode='primary' AND b.workspace=? AND a.agent_id=? AND a.active=1",
      )
      .all(team, agent.id) as { channel: string }[];
  return [
    ...new Set([
      ...Object.keys(agent.channels),
      ...stored.map(
        (row) => service.transport.mapper.target({ conversationId: row.channel }).channel,
      ),
    ]),
  ]
    .filter((channel) => {
      const bound = m.references.findConversation({
        provider: "slack",
        workspace: team,
        externalId: channel,
      });
      return !(bound && m.references.conversation(bound).authority === "internal");
    })
    .map((channel) => ({ channel, conversationId: channel }));
}

/** Confirms the platform permission of every remembered channel; false when one had no answer. */
export async function confirmRememberedChannels(
  service: SlackService,
  agentId: string,
): Promise<boolean> {
  const agent = installation(service, agentId);
  let complete = true;
  for (const channel of rememberedChannels(service, agentId))
    if ((await service.confirmMembership(agent, channel.channel)) === "unavailable")
      complete = false;
  return complete;
}

/** Recovers the local coverage of every remembered channel; false when one stayed incomplete. */
export async function recoverRememberedChannels(
  service: SlackService,
  agentId: string,
  forceFullOldThreads = false,
): Promise<boolean> {
  const agent = installation(service, agentId);
  let complete = true;
  for (const { channel } of rememberedChannels(service, agentId)) {
    const conversationId = service.transport.mapper.conversation(channel);
    if (
      (await service.recoverChannel(agent, conversationId, { forceFullOldThreads })) !== "complete"
    )
      complete = false;
  }
  return complete;
}
