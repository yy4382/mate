import { describe, it } from "vitest";
import { environment } from "./support.ts";

const ending = async (promise: Promise<void>, what: string) => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not end within 2000ms`)), 2000);
  });
  try {
    await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

describe("a watch of an Agent", () => {
  const stops = {
    "the Agent is deleted": (admin: Awaited<ReturnType<typeof setup>>["admin"], id: string) =>
      admin.deleteAgent(id),
    "the Agent is paused": (admin: Awaited<ReturnType<typeof setup>>["admin"], id: string) =>
      admin.pauseAgent(id),
    "the control plane closes": (admin: Awaited<ReturnType<typeof setup>>["admin"]) =>
      admin.close(),
  };

  async function setup() {
    const env = await environment();
    const admin = await env.open();
    env.useScriptedProvider(admin);
    const node = await env.pairNode(admin);
    const { agentId } = await env.hire(admin, node.nodeId);
    return { admin, agentId };
  }

  it.each(Object.entries(stops))("ends when %s", async (_when, stop) => {
    const { admin, agentId } = await setup();
    const primary = await admin.watchAgent(agentId, () => undefined);
    const again = await admin.watchAgent(agentId, () => undefined);

    await stop(admin, agentId);

    await ending(primary.ended, "the first watch");
    await ending(again.ended, "the second watch");
  });
});
