import {
  attachmentSummarySchema,
  ownerChannelSchema,
  ownerMessageSchema,
  ownerTaskSchema,
} from "@mate/protocol/owner";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ScenarioContext } from "../helpers/scenario-evidence.js";
import { readScenarioFacts } from "../helpers/scenario-facts.js";
import type { createScriptedProvider, ScriptedRequest } from "../helpers/scripted-provider.js";
import { scriptedToolResultSchemas } from "../helpers/scripted-tool-results.js";

export const reportWorkflowAgents = [{ name: "甲：报告作者" }, { name: "乙：独立复核" }];
const ownerRequest = "请用合成数值 2、4、6 制作报告，找同伴复核后交付文件。";
const reviewRequest = "请复核 draft.txt 的输入和总计，并反馈需补充的信息。";
const feedback = "总计正确，请补记录数 3。";
const draftContent = "输入：2,4,6\n总计：12\n";
const finalContent = "输入：2,4,6\n总计：12\n记录数：3\n";
const draftRunBody = "草稿已共享，本轮内部正文结束，主任务留待反馈后继续。";
const threadSchema = z.object({ root: ownerMessageSchema, replies: z.array(ownerMessageSchema) });
const tasksSchema = z.object({ tasks: z.array(ownerTaskSchema) });
const writeSchema = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) });
const readSchema = z.object({ content: z.string() });
const attachmentChunkSchema = z.object({
  attachment: attachmentSummarySchema,
  offset: z.number(),
  totalBytes: z.number(),
  content: z.string(),
  nextOffset: z.number(),
});

function messageWithText(messages: z.output<typeof ownerMessageSchema>[], text: string) {
  const message = messages.find((candidate) => candidate.text === text);
  assert.ok(message, `Expected actual message: ${text}`);
  return message;
}

/** One sample collaboration choice, reusable with the existing scenario environment and driver. */
export async function runReportWorkflow(
  { environment, driver, signal, step, effectFile }: ScenarioContext,
  provider: ReturnType<typeof createScriptedProvider>,
) {
  const [author, peer] = environment.agents;
  assert.ok(author && peer, "The report workflow needs two prepared Agents");
  assert.equal(environment.agents.length, 2);
  assert.deepEqual(author.summary.model, peer.summary.model);
  assert.notEqual(author.summary.sessionId, peer.summary.sessionId);
  const waits = { signal, timeoutMs: 15_000 };
  const peerObservation = await driver.observe(peer);
  let peerConversationId = "";

  function ownerMessage(request: ScriptedRequest) {
    return messageWithText(
      request.result("conversations.read", scriptedToolResultSchemas["conversations.read"])
        .messages,
      ownerRequest,
    );
  }
  function reviewMessage(request: ScriptedRequest) {
    return messageWithText(
      request.result("conversations.read", scriptedToolResultSchemas["conversations.read"])
        .messages,
      reviewRequest,
    );
  }
  function claimedTask(request: ScriptedRequest) {
    return request.result("tasks.claim", scriptedToolResultSchemas["tasks.claim"]);
  }
  function successfulCommand(request: ScriptedRequest, stdout: string) {
    const result = request.result("process.exec", scriptedToolResultSchemas["process.exec"]);
    assert.equal(result.state, "succeeded");
    assert.ok(result.receipt);
    assert.equal(result.receipt.code, 0);
    assert.equal(result.receipt.stdout, stdout);
    assert.equal(result.receipt.stderr, "");
    assert.equal(result.receipt.timedOut, false);
    return result;
  }

  provider.forAgent(author, [
    function readOwnerRequest(request) {
      assert.ok(JSON.stringify(request.payload.input).includes(ownerRequest));
      request.call("conversations.read", { conversationId: author.channelId });
    },
    async function createMainTask(request) {
      const message = ownerMessage(request);
      assert.deepEqual(message.author, { kind: "human", id: "owner" });
      assert.equal(message.rootId, null);
      assert.deepEqual(await driver.tasks(signal), [], "Owner sent an ordinary request");
      request.call("tasks.create", { messageId: message.id, title: "三条数值的报告" });
    },
    function claimMainTask(request) {
      const created = request.result(
        "tasks.create",
        scriptedToolResultSchemas["tasks.create"].extend({ status: z.literal("created") }),
      );
      assert.equal(created.task.messageId, ownerMessage(request).id);
      assert.equal(created.task.channelId, author.channelId);
      assert.equal(created.task.ownerAgentId, null);
      assert.equal(created.task.status, "open");
      request.call("tasks.claim", {
        taskId: created.task.id,
        expectedVersion: created.task.version,
      });
    },
    function writeValues(request) {
      assert.equal(claimedTask(request).ownerAgentId, author.summary.id);
      assert.equal(claimedTask(request).status, "in_progress");
      request.call("workspace.write", { path: "values.txt", content: "2\n4\n6\n" });
    },
    function generateDraft(request) {
      request.result("workspace.write", writeSchema);
      request.call("process.exec", {
        command: `awk '{values = values separator $1; separator = ","; sum += $1} END {printf "输入：%s\\n总计：%d\\n", values, sum}' values.txt > draft.txt && cat draft.txt`,
      });
    },
    function readDraft(request) {
      successfulCommand(request, draftContent);
      request.call("workspace.read", { path: "draft.txt" });
    },
    function discoverPeer(request) {
      assert.equal(request.result("workspace.read", readSchema).content, draftContent);
      request.call("agents.list", {});
    },
    function openPeerDm(request) {
      const colleagues = request.result(
        "agents.list",
        z.object({ agents: z.array(z.looseObject({ id: z.string(), name: z.string() })) }),
      ).agents;
      const colleague = colleagues.find((candidate) => candidate.name === peer.summary.name);
      assert.ok(colleague);
      assert.equal(colleague.id, peer.summary.id);
      request.call("conversations.open_dm", { targetAgentId: colleague.id });
    },
    function publishDraft(request) {
      const channel = request.result("conversations.open_dm", ownerChannelSchema);
      peerConversationId = channel.id;
      assert.notEqual(channel.id, author.channelId);
      assert.notEqual(channel.id, peer.channelId);
      assert.equal(channel.visibility, "private");
      request.call("attachments.publish", { conversationId: channel.id, path: "draft.txt" });
    },
    function inviteReview(request) {
      const attachment = request.result("attachments.publish", attachmentSummarySchema);
      assert.equal(attachment.channelId, peerConversationId);
      assert.deepEqual(attachment.uploader, { kind: "agent", id: author.summary.id });
      request.call("messages.send", {
        conversationId: peerConversationId,
        text: reviewRequest,
        asTask: true,
      });
    },
    function finishDraftRun(request) {
      const invitation = request.result("messages.send", ownerMessageSchema);
      assert.equal(invitation.channelId, peerConversationId);
      assert.equal(invitation.rootId, null);
      assert.equal(invitation.text, reviewRequest);
      assert.deepEqual(invitation.author, { kind: "agent", id: author.summary.id });
      request.text(draftRunBody);
    },
    function readPeerFeedback(request) {
      assert.ok(JSON.stringify(request.payload.input).includes(feedback));
      const first = provider.requests.find((candidate) => candidate.step === "finishDraftRun");
      assert.ok(first);
      assert.equal(request.sessionId, first.sessionId);
      assert.deepEqual(
        request.payload.input.slice(0, first.payload.input.length),
        first.payload.input,
        "R2 preserves the actual ordered R1 request prefix",
      );
      const continuation = request.payload.input.slice(first.payload.input.length);
      z.object({
        type: z.literal("message"),
        role: z.literal("assistant"),
        status: z.literal("completed"),
        content: z
          .array(z.object({ type: z.literal("output_text"), text: z.literal(draftRunBody) }))
          .length(1),
      }).parse(continuation[0]);
      assert.ok(
        JSON.stringify(continuation.slice(1)).includes(feedback),
        "The completed R1 assistant body precedes the actual peer feedback in R2",
      );
      const invitation = request.result("messages.send", ownerMessageSchema);
      request.call("conversations.read_thread", {
        conversationId: invitation.channelId,
        rootId: invitation.id,
      });
    },
    function reviseReport(request) {
      const thread = request.result("conversations.read_thread", threadSchema);
      assert.equal(thread.root.text, reviewRequest);
      const reply = messageWithText(thread.replies, feedback);
      assert.equal(reply.rootId, thread.root.id);
      assert.deepEqual(reply.author, { kind: "agent", id: peer.summary.id });
      request.call("process.exec", {
        command: `cp draft.txt report.txt && awk 'END {printf "记录数：%d\\n", NR}' values.txt >> report.txt && cat report.txt`,
      });
    },
    function publishFinalReport(request) {
      successfulCommand(request, finalContent);
      request.call("attachments.publish", {
        conversationId: author.channelId,
        path: "report.txt",
      });
    },
    function deliverToOwner(request) {
      const attachment = request.result("attachments.publish", attachmentSummarySchema);
      assert.equal(attachment.channelId, author.channelId);
      request.call("messages.send", {
        conversationId: author.channelId,
        rootId: ownerMessage(request).id,
        text: `报告已交付：${attachment.id}`,
      });
    },
    function completeMainTask(request) {
      const delivery = request.result("messages.send", ownerMessageSchema);
      assert.equal(delivery.rootId, ownerMessage(request).id);
      assert.deepEqual(delivery.author, { kind: "agent", id: author.summary.id });
      const task = claimedTask(request);
      request.call("tasks.update", {
        taskId: task.id,
        expectedVersion: task.version,
        status: "done",
      });
    },
    async function finishDeliveryRun(request) {
      const task = request.result("tasks.update", ownerTaskSchema);
      await step("main task is done while R2 is still running", async () => {
        assert.equal(task.id, claimedTask(request).id);
        await driver.waitForTask({ ...task, status: "done" }, waits);
        const reply = messageWithText(
          request.result("conversations.read_thread", threadSchema).replies,
          feedback,
        );
        return driver.waitForRun({ ...authorObservation, message: reply }, "running", waits);
      });
      request.text("最终交付后的内部正文结束。");
    },
  ]);

  provider.forAgent(peer, [
    function waitForAuthorR1(request) {
      assert.ok(JSON.stringify(request.payload.input).includes(reviewRequest));
      // The driver releases this real HTTP response only after observing the author's R1 completion.
    },
    function listReviewTasks(request) {
      const invitation = reviewMessage(request);
      assert.equal(invitation.channelId, peerConversationId);
      assert.deepEqual(invitation.author, { kind: "agent", id: author.summary.id });
      request.call("tasks.list", {});
    },
    function claimIndependentReview(request) {
      const tasks = request.result("tasks.list", tasksSchema).tasks;
      const task = tasks.find((candidate) => candidate.messageId === reviewMessage(request).id);
      assert.ok(task);
      assert.equal(task.ownerAgentId, null);
      assert.equal(task.status, "open");
      request.call("tasks.claim", { taskId: task.id, expectedVersion: task.version });
    },
    function findSharedAttachment(request) {
      const task = claimedTask(request);
      assert.equal(task.ownerAgentId, peer.summary.id);
      assert.equal(task.messageId, reviewMessage(request).id);
      assert.equal(task.channelId, peerConversationId);
      assert.equal(task.status, "in_progress");
      request.call("attachments.list", { conversationId: peerConversationId });
    },
    function readSharedAttachment(request) {
      const attachments = request.result(
        "attachments.list",
        z.object({ attachments: z.array(attachmentSummarySchema) }),
      ).attachments;
      const attachment = attachments.find((candidate) => candidate.filename === "draft.txt");
      assert.ok(attachment);
      assert.deepEqual(attachment.uploader, { kind: "agent", id: author.summary.id });
      request.call("attachments.read_chunk", {
        conversationId: peerConversationId,
        attachmentId: attachment.id,
        offset: 0,
      });
    },
    function copyActualAttachmentBytes(request) {
      const chunk = request.result("attachments.read_chunk", attachmentChunkSchema);
      assert.equal(chunk.offset, 0);
      assert.equal(chunk.totalBytes, Buffer.byteLength(draftContent));
      assert.equal(chunk.attachment.channelId, peerConversationId);
      assert.equal(chunk.nextOffset, chunk.totalBytes);
      assert.equal(chunk.content, draftContent);
      request.call("workspace.write_bytes", {
        path: "reviewed-draft.txt",
        base64: Buffer.from(chunk.content, "utf8").toString("base64"),
      });
    },
    function validateActualCopiedFile(request) {
      request.result("workspace.write_bytes", writeSchema);
      request.call("process.exec", {
        command: `awk -F'：' '/^输入：/ {count = split($2, values, ","); for (i = 1; i <= count; i++) sum += values[i]} /^总计：/ {reported = $2} END {if (count == 0 || reported != sum) exit 1; printf "总计正确：%d\\n记录数：%d\\n", sum, count}' reviewed-draft.txt`,
      });
    },
    function replyWithActualValidation(request) {
      successfulCommand(request, "总计正确：12\n记录数：3\n");
      request.call("messages.send", {
        conversationId: peerConversationId,
        rootId: reviewMessage(request).id,
        text: feedback,
      });
    },
    function completeReviewTask(request) {
      const reply = request.result("messages.send", ownerMessageSchema);
      assert.equal(reply.rootId, reviewMessage(request).id);
      assert.equal(reply.text, feedback);
      assert.deepEqual(reply.author, { kind: "agent", id: peer.summary.id });
      const task = claimedTask(request);
      request.call("tasks.update", {
        taskId: task.id,
        expectedVersion: task.version,
        status: "done",
      });
    },
    async function finishReviewRun(request) {
      const task = request.result("tasks.update", ownerTaskSchema);
      await step("review task is done while the peer run is still running", async () => {
        await driver.waitForTask({ ...task, status: "done" }, waits);
        return driver.waitForRun(
          { ...peerObservation, message: reviewMessage(request) },
          "running",
          waits,
        );
      });
      request.text("独立复核后的内部正文结束。");
    },
  ]);

  effectFile("author/values.txt", join(author.workspace, "values.txt"));
  effectFile("author/draft.txt", join(author.workspace, "draft.txt"));
  effectFile("peer/reviewed-draft.txt", join(peer.workspace, "reviewed-draft.txt"));
  effectFile("author/report.txt", join(author.workspace, "report.txt"));
  const work = await step("Owner sends an ordinary work request", () =>
    driver.sendOwnerMessage(author, ownerRequest),
  );
  const held = await provider.waitFor(peer.summary.id, "waitForAuthorR1");
  const r1 = await step("author R1 completes with its task still in progress", async () => {
    assert.equal(held.state, "pending");
    const run = await driver.waitForRun(work, "completed", waits);
    const last = await provider.waitFor(author.summary.id, "finishDraftRun");
    await driver.waitForTask({ ...claimedTask(last), status: "in_progress" }, waits);
    const invitation = last.result("messages.send", ownerMessageSchema);
    const tasks = await driver.tasks(signal);
    assert.equal(tasks.length, 2);
    const reviewTask = tasks.find((task) => task.messageId === invitation.id);
    assert.ok(reviewTask);
    assert.equal(reviewTask.channelId, peerConversationId);
    assert.equal(reviewTask.status, "open");
    assert.equal(reviewTask.ownerAgentId, null);
    assert.notEqual(reviewTask.id, claimedTask(last).id);
    assert.equal(claimedTask(last).messageId, work.message.id);
    assert.deepEqual(
      (await driver.messages(author.channelId, signal)).map((message) => message.text),
      [ownerRequest],
    );
    assert.deepEqual(await driver.messages(peerConversationId, signal), [invitation]);
    return run;
  });
  const draft = await step("published draft equals the author's actual file", async () => {
    const request = await provider.waitFor(author.summary.id, "finishDraftRun");
    return driver.assertAttachment({
      agent: author,
      channelId: peerConversationId,
      attachmentId: request.result("attachments.publish", attachmentSummarySchema).id,
      path: "draft.txt",
      expectedBytes: Buffer.from(draftContent),
    });
  });
  const authorObservation = await driver.observe(author);
  await step("release only the peer's held HTTP response after R1", () => {
    assert.equal(held.state, "pending");
    assert.equal(
      held.call("conversations.read", { conversationId: peerConversationId }),
      "responded",
    );
    return { authorRunId: r1.id, peerSessionId: held.sessionId };
  });
  const review = await provider.waitFor(peer.summary.id, "finishReviewRun");
  const reply = review.result("messages.send", ownerMessageSchema);
  const peerRun = await step("peer finishes its independent review run", () =>
    driver.waitForRun({ ...peerObservation, message: reviewMessage(review) }, "completed", waits),
  );
  const r2 = await step(
    "actual feedback triggers author's R2 in the original session",
    async () => {
      const run = await driver.waitForRun(
        { ...authorObservation, message: reply },
        "completed",
        waits,
      );
      assert.notEqual(run.id, r1.id);
      assert.equal(run.sessionId, r1.sessionId);
      assert.notEqual(peerRun.sessionId, run.sessionId);
      return run;
    },
  );
  const delivery = await provider.waitFor(author.summary.id, "finishDeliveryRun");
  const tasks = await step("both independently anchored tasks are explicitly done", async () => {
    const mainTask = delivery.result("tasks.update", ownerTaskSchema);
    const reviewTask = review.result("tasks.update", ownerTaskSchema);
    assert.equal(mainTask.messageId, work.message.id);
    assert.equal(mainTask.ownerAgentId, author.summary.id);
    assert.equal(reviewTask.messageId, reviewMessage(review).id);
    assert.equal(reviewTask.ownerAgentId, peer.summary.id);
    assert.notEqual(mainTask.id, reviewTask.id);
    await driver.waitForTask({ ...mainTask, status: "done" }, waits);
    await driver.waitForTask({ ...reviewTask, status: "done" }, waits);
    const actual = await driver.tasks(signal);
    assert.equal(actual.length, 2);
    return actual;
  });
  const final = await step(
    "Owner downloads the revised report delivered in the original thread",
    async () => {
      const message = delivery.result("messages.send", ownerMessageSchema);
      const attachment = delivery.result("attachments.publish", attachmentSummarySchema);
      await driver.waitForMessage(
        {
          ...message,
          channelId: author.channelId,
          rootId: work.message.id,
          text: `报告已交付：${attachment.id}`,
        },
        waits,
      );
      assert.deepEqual((await driver.thread(author.channelId, work.message.id, signal)).replies, [
        message,
      ]);
      assert.deepEqual(
        (await driver.thread(peerConversationId, reviewMessage(review).id, signal)).replies,
        [reply],
      );
      assert.deepEqual(
        (await driver.messages(author.channelId, signal)).map((item) => item.text),
        [ownerRequest],
      );
      assert.deepEqual(
        (await driver.messages(peerConversationId, signal)).map((item) => item.text),
        [reviewRequest],
      );
      assert.deepEqual(await driver.messages(peer.channelId, signal), []);
      assert.deepEqual(readFileSync(join(peer.workspace, "reviewed-draft.txt")), draft.bytes);
      return driver.assertAttachment({
        agent: author,
        channelId: author.channelId,
        attachmentId: attachment.id,
        path: "report.txt",
        expectedBytes: Buffer.from(finalContent),
      });
    },
  );
  await step("each Agent has one session and at most one current run", async () => {
    const sessions = z
      .array(z.object({ id: z.string(), agentId: z.string() }))
      .parse(readScenarioFacts(environment.directory).sessions);
    assert.equal(sessions.length, 2);
    for (const agent of [author, peer]) {
      assert.deepEqual(
        sessions.filter((session) => session.agentId === agent.summary.id),
        [{ id: agent.summary.sessionId, agentId: agent.summary.id }],
      );
      const current = new Set<string>();
      const started = [];
      for (const event of await driver.activity(agent.summary.id, 0, signal)) {
        if (event.kind === "run.started") {
          assert.ok(event.referenceId);
          assert.equal(current.size, 0, "No concurrent run for one Agent");
          current.add(event.referenceId);
          started.push(event.referenceId);
        } else if (event.kind === "run.completed") {
          assert.ok(event.referenceId);
          assert.equal(current.delete(event.referenceId), true);
        }
      }
      assert.equal(current.size, 0);
      assert.deepEqual(started, agent === author ? [r1.id, r2.id] : [peerRun.id]);
    }
    await provider.assertComplete();
    return { sessions, authorRuns: [r1.id, r2.id], peerRun: peerRun.id };
  });
  return {
    authorRuns: [r1, r2],
    peerRun,
    tasks,
    attachments: [draft.attachment, final.attachment],
  };
}
