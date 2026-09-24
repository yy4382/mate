import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { daemonConfigSchema } from "../../src/daemon/config.js";
import { Daemon } from "../../src/daemon/app.js";
import { LocalConsole } from "../../src/local/console.js";
import { main } from "../../src/main.js";
import { requiredSlackBotScopes } from "../../src/slack/protocol.js";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});
const example = (name: string) =>
  daemonConfigSchema.parse(JSON.parse(readFileSync(resolve(name), "utf8")));

it("ships matching two-Agent examples with platform bindings outside Agent identity", () => {
  const slack = example("mate.example.json"),
    local = example("mate.local.example.json");
  expect(slack.mate.agents).toEqual(local.mate.agents);
  expect(slack.mate.agents.map((agent) => agent.id)).toEqual(["research", "writer"]);
  expect(slack.mate.agents.every((agent) => !("slackUserId" in agent))).toBe(true);
  expect(slack.adapters.slack?.bindings.map((binding) => binding.agentId)).toEqual([
    "research",
    "writer",
  ]);
  expect(slack.adapters.local).toBeUndefined();
  expect(local.adapters.slack).toBeUndefined();
  expect(local.adapters.local?.rooms).toEqual([
    { id: "team-room", agents: ["research", "writer"], humans: ["owner"] },
  ]);
  const operations = readFileSync(resolve("docs/OPERATIONS.md"), "utf8");
  expect(operations).toContain("slack-manifest");
  expect(operations).toContain("完整权限清单以生成文件为准");
  expect(requiredSlackBotScopes).toContain("commands");
});

it("labels configuration checks without claiming external Slack or provider connectivity", async () => {
  const refs = [
    "MODEL_API_KEY",
    "RESEARCH_BOT_TOKEN",
    "RESEARCH_APP_TOKEN",
    "WRITER_BOT_TOKEN",
    "WRITER_APP_TOKEN",
  ];
  const previous = Object.fromEntries(refs.map((ref) => [ref, process.env[ref]]));
  for (const ref of refs) process.env[ref] = "synthetic";
  cleanup.push(() => {
    for (const ref of refs) {
      if (previous[ref] === undefined) delete process.env[ref];
      else process.env[ref] = previous[ref];
    }
  });
  let output = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
    output += String(chunk);
    return true;
  });
  await main(["check", "mate.example.json"]);
  expect(JSON.parse(output)).toMatchObject({
    checkScope: "configuration_model_and_secret_references",
    externalConnectivityChecked: false,
    adapters: { slackConfigured: true, localConfigured: false },
    requiredSlackBotScopes: [...requiredSlackBotScopes],
    agents: [
      { agent: "research", modelKnown: true, missingEnv: [] },
      { agent: "writer", modelKnown: true, missingEnv: [] },
    ],
  });
});

it("runs the preconfigured team through the permanent daemon while preserving independent speak and silence choices", async () => {
  let now = 19_999;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mate-experiment-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const config = example("mate.local.example.json");
  config.runtime.dataDir = join(root, "data");
  const previous = process.env.MODEL_API_KEY;
  process.env.MODEL_API_KEY = "synthetic";
  cleanup.push(() => {
    if (previous === undefined) delete process.env.MODEL_API_KEY;
    else process.env.MODEL_API_KEY = previous;
  });
  const daemon = await Daemon.create(config, {
    info: () => {},
    error: () => {},
  });
  cleanup.push(() => daemon.close());
  vi.spyOn(daemon.supervisor, "recovery").mockResolvedValue("synthetic recovery");
  const ownerRuns: string[] = [];
  let ownerMessageId = "";
  vi.spyOn(daemon.supervisor, "factory").mockImplementation((agent) => ({
    close() {},
    async run(_spec, hooks) {
      const delivery = daemon.store.db
        .prepare(
          "SELECT d.payload FROM runs r JOIN deliveries d ON d.id=r.delivery_id WHERE r.agent_id=? AND r.state='active'",
        )
        .get(agent.id) as { payload: string };
      const payload = JSON.parse(delivery.payload);
      if (payload.messageKey !== ownerMessageId)
        return {
          tokens: 1,
          cost: 0,
          certain: true,
          waiting: false,
          continuation: false,
        };
      const view = (
        await hooks.tool(`read-${agent.id}`, "attention.read", {
          target: payload.target,
        })
      ).value as any;
      if (
        !view.messages.some(
          (message: any) =>
            message.id === ownerMessageId &&
            message.text === "Choose independently whether to respond.",
        )
      )
        throw new Error("Owner input was not presented to this Agent");
      ownerRuns.push(agent.id);
      if (agent.id === "research") {
        const draft = (
          await hooks.tool("reply", "messages.send", {
            target: payload.target,
            text: "I will investigate and keep the team updated.",
          })
        ).value as any;
        await hooks.tool("send", "drafts.continue", {
          draftId: draft.draftId,
          revision: draft.revision,
          holdId: draft.holdId,
          acknowledge: "send_despite_unread_or_changes",
        });
      }
      return {
        tokens: 2,
        cost: 0,
        certain: true,
        waiting: false,
        continuation: false,
      };
    },
  }));
  const console = new LocalConsole(daemon.local!, daemon.controls);
  ownerMessageId = (
    console.execute({
      id: "input",
      op: "send",
      human: "owner",
      eventId: "experiment-input",
      target: { conversationId: "team-room" },
      text: "Choose independently whether to respond.",
    }).result as { messageId: string }
  ).messageId;
  const queued = (
    daemon.store.db.prepare("SELECT agent_id,payload FROM deliveries ORDER BY agent_id").all() as {
      agent_id: string;
      payload: string;
    }[]
  ).map((row) => ({
    agentId: row.agent_id,
    messageKey: JSON.parse(row.payload).messageKey,
  }));
  expect(queued).toEqual([
    { agentId: "research", messageKey: ownerMessageId },
    { agentId: "writer", messageKey: ownerMessageId },
  ]);
  now = 20_000; // Cross the normal batched-notice boundary without changing its semantics.
  await daemon.start();
  await vi.waitFor(() => expect(ownerRuns.sort()).toEqual(["research", "writer"]), {
    timeout: 3000,
  });
  await vi.waitFor(
    () =>
      expect(
        daemon
          .local!.read("owner", { conversationId: "team-room" })
          .messages.some(
            (message) => message.text === "I will investigate and keep the team updated.",
          ),
      ).toBe(true),
    { timeout: 3000 },
  );
  expect(daemon.store.db.prepare("SELECT count(*) n FROM runs WHERE state='failed'").get()).toEqual(
    { n: 0 },
  );
  expect(
    daemon
      .local!.read("owner", { conversationId: "team-room" })
      .messages.filter((message) => message.author.kind === "agent"),
  ).toHaveLength(1);
});
