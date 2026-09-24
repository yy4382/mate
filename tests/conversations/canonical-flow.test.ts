import { afterEach, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Store } from "../../src/storage/store.js";
import { References } from "../../src/conversations/references.js";
import { CanonicalWrites } from "../../src/storage/conversation-writes.js";
import { Conversations } from "../../src/conversations/messages.js";
import { ConfiguredAgents } from "../../src/agents/directory.js";
import { CanonicalAttention } from "../../src/conversations/attention.js";
import { CanonicalFreshnessGate } from "../../src/conversations/freshness.js";
import {
  CanonicalOutput,
  type DispatchEnvelope,
  type MessageConfirmation,
} from "../../src/conversations/output.js";
import { slackApplication } from "../../src/slack/application.js";
import { configFixture } from "../helpers/config.js";
const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));
function setup() {
  const s = new Store(":memory:");
  stores.push(s);
  s.register("research", "test", []);
  const refs = new References(s),
    app = slackApplication(s, configFixture),
    records = app.messages.records,
    writes = app.messages.writes;
  const messages = new Conversations(
    s,
    new ConfiguredAgents(configFixture.agents),
    refs,
    records,
    writes,
    { participates: () => true },
  );
  refs.createConversation("channel", "external", "opaque-space");
  refs.createMessage("opaque-space", "root");
  messages.membership("research", "opaque-space", true);
  const attention = new CanonicalAttention(messages),
    gate = new CanonicalFreshnessGate(messages, attention),
    requests: DispatchEnvelope[] = [];
  const confirmation = (request: DispatchEnvelope): MessageConfirmation => ({
    message: {
      id: `sent:${request.id}`,
      conversationId: request.target.conversationId,
      rootId: request.target.threadId ?? `sent:${request.id}`,
      author: { kind: "agent", id: request.actor },
      origin: "participant",
      text: request.text,
      mentions: [],
      deleted: false,
      order: "100",
      revision: "100",
      attachments: [],
    },
    receipt: { external: "receipt" },
  });
  const output = new CanonicalOutput(messages, {
    post: async (request) => {
      requests.push(request);
      return confirmation(request);
    },
    pendingInput: () => false,
    classify: () => ({ kind: "unknown" }),
  });
  output.gate = gate;
  s.enqueue("research", "start", {});
  const run = s.beginRun("research")!;
  s.input(run, {});
  const target = { conversationId: "opaque-space", threadId: "root" };
  const read = () => {
    const view = attention.read(run, target) as { viewToken: string };
    attention.presented(run, {
      role: "toolResult",
      toolCallId: "read",
      toolName: "mate",
      content: [{ type: "text", text: JSON.stringify(view) }],
      isError: false,
      timestamp: 0,
    } as AgentMessage);
    return view.viewToken;
  };
  return { s, messages, attention, gate, output, run, target, read, requests, confirmation };
}
it("uses canonical identity across presentation, freshness, confirmation and duplicate echo", async () => {
  const { output, read, run, target, s, messages, requests, confirmation } = setup();
  output.queue("research", target, "answer", "send", { run, viewToken: read() });
  const original = s.output("send")!;
  await output.send("send");
  expect(requests[0]?.requestHash).toBe(original.request_hash);
  expect(requests[0]?.originalRequest).toBe(original.request);
  expect(s.output("send")?.state).toBe("sent");
  expect(messages.read("research", target)[0]?.text).toBe("answer");
  const events = s.db.prepare("SELECT count(*) n FROM conversation_events").get();
  output.confirm("send", original.request_hash, confirmation(requests[0]!));
  expect(s.db.prepare("SELECT count(*) n FROM conversation_events").get()).toEqual(events);
});
it("keeps revise, silence and explicit continue reachable without a platform-shaped target", async () => {
  const { output, gate, run, target, requests, s } = setup();
  output.queue("research", target, "first", "draft", { run });
  expect(s.output("draft")?.state).toBe("held");
  const revised = gate.revise(run, "draft", 1, "revised") as { revision: number; holdId: string };
  gate.continueOnce(run, "draft", revised.revision, revised.holdId);
  await output.send("draft:revision:2");
  expect(requests[0]?.text).toBe("revised");
  output.queue("research", target, "silent", "silent", { run });
  gate.discard(run, "silent", 1);
  await output.send("silent");
  expect(requests).toHaveLength(1);
  expect(s.db.prepare("SELECT count(*) n FROM attention_seen").get()).toEqual({ n: 0 });
});
it("rejects fabricated confirmations for held drafts before any message is committed", () => {
  const { output, run, target, s, confirmation } = setup();
  output.queue("research", target, "unsent", "held", { run });
  const row = s.output("held")!;
  const request = {
    id: "held",
    actor: "research",
    target,
    text: "unsent",
    requestHash: row.request_hash,
    originalRequest: row.request,
  };
  expect(() => output.confirm("held", row.request_hash, confirmation(request))).toThrow(
    "not dispatched",
  );
  expect(s.db.prepare("SELECT count(*) n FROM messages").get()).toEqual({ n: 0 });
});
