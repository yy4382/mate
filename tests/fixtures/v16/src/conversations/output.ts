import { z } from "zod";
import { randomUUID } from "node:crypto";
import { encode } from "../../../../../src/storage/store.js";
import type { FreshnessGate, SendBasis } from "./freshness.js";
import {
  Messages,
  slackTs,
  targetSchema,
  messageKey,
  type NormalMessage,
  type Target,
} from "./messages.js";

export interface ArtifactPayload {
  title: string;
  content: string;
  contentHash: string;
  encoding?: "base64";
  filename?: string;
}
export interface ArtifactOutputTransport {
  upload(
    agentId: string,
    target: Target,
    text: string,
    artifact: ArtifactPayload,
    prepared: (fileId: string) => void,
    beforeShare: () => boolean,
  ): Promise<{ fileId: string }>;
}
export interface MessageTransport {
  post(agentId: string, target: Target, text: string, id: string): Promise<{ ts: string }>;
}
export class Output {
  gate?: FreshnessGate;
  artifacts?: ArtifactOutputTransport;
  private dispatchQueue: Promise<unknown> = Promise.resolve();
  constructor(
    private messages: Messages,
    private transport: MessageTransport,
    private clock: () => number = Date.now,
  ) {}
  queue(
    agentId: string,
    target: Target,
    text: string,
    id: string = randomUUID(),
    basis?: SendBasis,
  ): string {
    targetSchema.parse(target);
    this.messages.requireAccess(agentId, target.channel);
    z.string().min(1).max(35000).parse(text);
    this.messages.store.atomic(() => {
      this.messages.persistence.writes.queueOutput(agentId, id, { target, text });
      this.gate?.queued(agentId, id, basis);
    });
    return id;
  }
  queueArtifact(
    agentId: string,
    target: Target,
    text: string,
    artifact: ArtifactPayload,
    id: string,
    basis: SendBasis,
  ): string {
    targetSchema.parse(target);
    this.messages.requireAccess(agentId, target.channel);
    z.string().min(1).max(35000).parse(text);
    this.messages.store.atomic(() => {
      this.messages.persistence.writes.queueOutput(agentId, id, { target, text, artifact });
      this.gate?.queued(agentId, id, basis);
    });
    return id;
  }
  reconcileArtifact(
    id: string,
    fileId: string,
    evidence: { channel: string; thread?: string; ts: string; user: string },
  ): void {
    const row = this.messages.store.output(id);
    if (!row || row.state !== "unknown") throw new Error("Output does not require reconciliation");
    const request = JSON.parse(row.request),
      receipt = JSON.parse(row.receipt ?? "{}");
    if (
      !request.artifact ||
      receipt.fileId !== fileId ||
      evidence.user !== this.messages.agent(row.agent_id).slackUserId ||
      evidence.channel !== request.target.channel ||
      (request.target.thread ?? evidence.ts) !== (evidence.thread ?? evidence.ts)
    )
      throw new Error("Artifact receipt evidence mismatch");
    slackTs.parse(evidence.ts);
    this.confirmArtifact(id, row.agent_id, request.target, { fileId }, "unknown");
  }
  private confirmArtifact(
    id: string,
    actor: string,
    target: Target,
    receipt: { fileId: string },
    from: "sending" | "unknown",
  ): void {
    const s = this.messages.store;
    s.atomic(() => {
      s.transitionOutput(id, from, "sent", receipt);
      s.db
        .prepare(
          "INSERT INTO conversation_events(channel,thread,message_key,revision,kind) VALUES(?,?,?,?,?)",
        )
        .run(
          target.channel,
          target.thread ?? "",
          `artifact:${receipt.fileId}`,
          receipt.fileId,
          "artifact",
        );
      s.audit("artifact_published", { outputId: id, actor, target, ...receipt });
    });
  }
  /** Evidence must come from a fresh Slack history response using the sender's credential. */
  reconcile(
    id: string,
    evidence: {
      ts: string;
      user: string;
      channel: string;
      thread: string;
      text: string;
      outboxId: string;
      requestHash: string;
    },
  ): void {
    const row = this.messages.store.output(id);
    if (!row || row.state !== "unknown") throw new Error("Output does not require reconciliation");
    const { target, text } = JSON.parse(row.request) as { target: Target; text: string };
    if (JSON.parse(row.request).artifact)
      throw new Error("Artifact requires file sharing evidence");
    if (
      evidence.outboxId !== id ||
      evidence.requestHash !== row.request_hash ||
      evidence.user !== this.messages.agent(row.agent_id).slackUserId ||
      evidence.channel !== target.channel ||
      evidence.thread !== (target.thread ?? evidence.ts)
    )
      throw new Error("Receipt evidence mismatch");
    slackTs.parse(evidence.ts);
    this.confirm(id, row.agent_id, target, evidence.text, { ts: evidence.ts }, "unknown");
  }
  private confirm(
    id: string,
    agentId: string,
    target: Target,
    text: string,
    receipt: { ts: string },
    from: "sending" | "unknown",
  ): void {
    this.messages.store.atomic(() => {
      this.messages.store.transitionOutput(id, from, "sent", receipt);
      const agent = this.messages.agent(agentId);
      const message: NormalMessage = {
        team: this.messages.config.teamId,
        channel: target.channel,
        thread: target.thread ?? receipt.ts,
        ts: receipt.ts,
        revision: receipt.ts,
        text,
        user: agent.slackUserId,
        bot: agent.slackBotId,
        deleted: false,
      };
      if (
        this.messages.store.db
          .prepare("SELECT 1 FROM system_projections WHERE output_id=?")
          .get(id) &&
        text === JSON.parse(this.messages.store.output(id)!.request).text
      )
        message.systemGenerated = true;
      this.messages.record(message, []);
      const binding = this.messages.store.db
        .prepare("SELECT work_id FROM output_work WHERE output_id=?")
        .get(id) as { work_id: string } | undefined;
      if (binding) {
        const key = messageKey(message);
        this.messages.store.db
          .prepare("INSERT INTO message_work VALUES(?,?) ON CONFLICT DO NOTHING")
          .run(key, binding.work_id);
        this.messages.store.db
          .prepare(
            "INSERT INTO delivery_work SELECT d.id,? FROM deliveries d WHERE json_extract(d.payload,'$.messageKey')=? ON CONFLICT DO NOTHING",
          )
          .run(binding.work_id, key);
      }
      this.messages.record(
        message,
        this.messages.config.agents
          .filter((a) => this.messages.access(a.id, target.channel))
          .map((a) => a.id),
      );
    });
  }
  private validateOutstanding(): void {
    for (const row of this.messages.store.db
      .prepare("SELECT id FROM outbox WHERE state IN ('pending','held','sending','unknown')")
      .all() as { id: string }[]) {
      this.messages.persistence.records.targetedEffect("outbox", row.id);
    }
  }
  ready(limit = 20): { id: string }[] {
    this.validateOutstanding();
    // Eligibility precedes LIMIT so a blocked target cannot starve other conversations.
    // sendNow repeats these checks at the actual dispatch boundary.
    return this.messages.store.db
      .prepare(
        `
      SELECT o.id FROM outbox o JOIN canonical_targets ot ON ot.object_type='outbox' AND ot.object_id=o.id LEFT JOIN output_work ow ON ow.output_id=o.id LEFT JOIN works w ON w.id=ow.work_id
      WHERE o.state='pending' AND NOT EXISTS(SELECT 1 FROM agents a WHERE a.id=o.agent_id AND a.paused=1)
      AND (w.state IS NULL OR w.state!='paused') AND COALESCE(json_extract(o.receipt,'$.retryAt'),0)<=?
      AND (?=0 OR (
        NOT EXISTS(SELECT 1 FROM ingress i WHERE i.normalized=0 AND (json_extract(i.body,'$.event.channel')=(SELECT external_id FROM conversation_bindings cb WHERE cb.conversation_id=ot.conversation_id AND cb.mode='primary') OR json_extract(i.body,'$.command') IS NOT NULL))
        AND NOT EXISTS(SELECT 1 FROM outbox prior JOIN canonical_targets pt ON pt.object_type='outbox' AND pt.object_id=prior.id WHERE prior.id!=o.id AND prior.state IN ('sending','unknown')
          AND pt.conversation_id=ot.conversation_id
          AND (pt.thread_id IS NULL OR ot.thread_id IS NULL OR pt.thread_id=ot.thread_id))
      ))
      AND NOT EXISTS(SELECT 1 FROM outbox prior WHERE prior.id!=o.id AND prior.agent_id=o.agent_id AND prior.state IN ('sending','unknown')
        AND json_extract(o.request,'$.artifact.contentHash') IS NOT NULL AND json_extract(prior.request,'$.artifact.contentHash')=json_extract(o.request,'$.artifact.contentHash'))
      ORDER BY o.rowid LIMIT ?
    `,
      )
      .all(this.clock(), Number(!!this.gate), limit) as { id: string }[];
  }
  send(id: string): Promise<void> {
    const next = this.dispatchQueue.then(() => this.sendNow(id));
    this.dispatchQueue = next.catch(() => {});
    return next;
  }
  private async sendNow(id: string): Promise<void> {
    const now = this.clock();
    const store = this.messages.store,
      row = store.output(id);
    if (!row || row.state !== "pending") return;
    this.validateOutstanding();
    const canonical = this.messages.persistence.records.targetedEffect("outbox", id).target;
    if (store.db.prepare("SELECT 1 FROM agents WHERE id=? AND paused=1").get(row.agent_id)) return;
    const work = store.db
      .prepare(
        "SELECT w.state FROM works w JOIN output_work ow ON ow.work_id=w.id WHERE ow.output_id=?",
      )
      .get(id) as { state: string } | undefined;
    if (work && work.state !== "active") {
      if (work.state === "cancelled")
        store.transitionOutput(id, "pending", "failed", { reason: "work_cancelled" });
      return;
    }
    if (row.receipt && (JSON.parse(row.receipt) as { retryAt?: number }).retryAt! > now) return;
    const { target, text, artifact } = JSON.parse(row.request) as {
      target: Target;
      text: string;
      artifact?: ArtifactPayload;
    };
    try {
      this.messages.requireAccess(row.agent_id, target.channel);
    } catch {
      store.transitionOutput(id, "pending", "failed", { reason: "access_revoked" });
      return;
    }
    // Ingress is durable before Slack ACK/replay. Wait for trusted replay to normalize
    // related events (and owner controls) before accepting a local revision as current.
    if (
      this.gate &&
      store.db
        .prepare(
          "SELECT 1 FROM ingress WHERE normalized=0 AND (json_extract(body,'$.event.channel')=? OR json_extract(body,'$.command') IS NOT NULL)",
        )
        .get(target.channel)
    )
      return;
    // An unconfirmed earlier dispatch may already have changed this discussion.
    if (
      this.gate &&
      store.db
        .prepare(
          "SELECT 1 FROM outbox o JOIN canonical_targets ct ON ct.object_type='outbox' AND ct.object_id=o.id WHERE o.id!=? AND o.state IN ('sending','unknown') AND ct.conversation_id=? AND (ct.thread_id IS NULL OR ? IS NULL OR ct.thread_id=?)",
        )
        .get(id, canonical.conversationId, canonical.threadId ?? null, canonical.threadId ?? null)
    )
      return;
    if (
      artifact &&
      store.db
        .prepare(
          "SELECT 1 FROM outbox WHERE id!=? AND agent_id=? AND state IN ('sending','unknown') AND json_extract(request,'$.artifact.contentHash')=?",
        )
        .get(id, row.agent_id, artifact.contentHash)
    )
      return;
    if (this.gate && !this.gate.dispatch(id)) return;
    store.transitionOutput(id, "pending", "sending", artifact ? { phase: "staging" } : undefined);
    if (artifact) {
      let fileId: string | undefined,
        shareStarted = false;
      try {
        if (!this.artifacts) throw new Error("Artifact transport unavailable");
        const receipt = await this.artifacts.upload(
          row.agent_id,
          target,
          text,
          artifact,
          (id) => {
            fileId = id;
            store.db
              .prepare("UPDATE outbox SET receipt=? WHERE id=? AND state='sending'")
              .run(encode({ fileId: id, phase: "staging" }), row.id);
          },
          () => {
            if (store.output(id)?.state !== "sending") return false;
            store.transitionOutput(id, "sending", "pending", { fileId, phase: "staging" });
            if (store.db.prepare("SELECT 1 FROM agents WHERE id=? AND paused=1").get(row.agent_id))
              return false;
            const state = store.db
              .prepare(
                "SELECT w.state FROM works w JOIN output_work ow ON ow.work_id=w.id WHERE ow.output_id=?",
              )
              .get(id) as { state: string } | undefined;
            if (state && state.state !== "active") return false;
            if (!this.messages.access(row.agent_id, target.channel)) return false;
            if (
              store.db
                .prepare(
                  "SELECT 1 FROM ingress WHERE normalized=0 AND (json_extract(body,'$.event.channel')=? OR json_extract(body,'$.command') IS NOT NULL)",
                )
                .get(target.channel)
            )
              return false;
            if (this.gate && !this.gate.dispatch(id)) return false;
            store.transitionOutput(id, "pending", "sending", { fileId, phase: "sharing" });
            shareStarted = true;
            return true;
          },
        );
        if (!shareStarted || !receipt.fileId || receipt.fileId !== fileId)
          throw new Error("Artifact receipt mismatch");
        this.confirmArtifact(id, row.agent_id, target, receipt, "sending");
      } catch {
        if (store.output(id)?.state === "sending")
          store.transitionOutput(id, "sending", shareStarted ? "unknown" : "failed", {
            reason: shareStarted ? "artifact_outcome_unknown" : "artifact_not_shared",
            ...(fileId ? { fileId } : {}),
          });
      }
      return;
    }
    let receipt: { ts: string };
    try {
      receipt = await this.transport.post(row.agent_id, target, text, id);
      slackTs.parse(receipt.ts);
    } catch (error) {
      const e = error as { code?: string; retryAfter?: number; data?: { error?: string } };
      if (e.code === "slack_webapi_rate_limited_error" && Number.isFinite(e.retryAfter)) {
        store.transitionOutput(id, "sending", "pending", {
          retryAt: this.clock() + Math.max(1, e.retryAfter!) * 1000,
        });
      } else if (
        e.code === "slack_webapi_platform_error" &&
        [
          "not_authed",
          "invalid_auth",
          "token_revoked",
          "account_inactive",
          "channel_not_found",
          "not_in_channel",
          "is_archived",
          "msg_too_long",
          "no_text",
          "restricted_action",
          "cannot_reply_to_message",
        ].includes(e.data?.error ?? "")
      )
        store.transitionOutput(id, "sending", "failed", { reason: e.data!.error });
      else store.transitionOutput(id, "sending", "unknown", { reason: "request_outcome_unknown" });
      return;
    }
    // Receipt and replayable internal event commit together. If this fails,
    // sending becomes unknown at restart; never resend an unrecorded success.
    this.confirm(id, row.agent_id, target, text, receipt, "sending");
  }
}
