import type { ArtifactTransportProvider } from "../conversations/output.js";
import type { PublishArgs } from "../capabilities/artifacts.js";
export type { PublishArgs } from "../capabilities/artifacts.js";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { RunToken } from "../storage/store.js";
import { hash } from "../storage/store.js";
import type { Broker } from "../policy/broker.js";
import type { Collaboration } from "../collaboration/service.js";
import type { ConversationTarget } from "../domain/conversations.js";

import type { ExecutionResult } from "../execution/backend.js";
/** Publication tool. The external artifact adapter is looked up, never installed here. */
export class Artifacts {
  constructor(
    readonly collaboration: Collaboration,
    readonly broker: Broker,
    readonly transport: ArtifactTransportProvider,
    readonly memoryRoots: Record<string, string>,
  ) {}
  configured(actor: string): boolean {
    return this.transport()?.configured(actor) === true;
  }
  supports(actor: string, target: ConversationTarget): boolean {
    const transport = this.transport();
    return transport?.configured(actor) === true && transport.supports(actor, target);
  }
  async publish(
    run: RunToken,
    workId: string,
    actionId: string,
    args: PublishArgs,
    signal: AbortSignal,
  ): Promise<unknown> {
    const c = this.collaboration,
      s = c.store,
      gate = c.output.gate;
    if (!gate) throw new Error("Publication gate unavailable");
    s.assertRun(run);
    c.assertActionWork(run, workId);
    c.output.requireArtifactSupport(run.agentId, args.target);
    const result = async (id: string, operation: unknown) => {
      const read = (await this.broker.execute(run, workId, id, operation, signal)) as
        ExecutionResult | { receipt?: ExecutionResult };
      const file = "code" in read ? read : read.receipt;
      if (!file || file.code !== 0 || file.truncated)
        throw new Error("Artifact read failed or incomplete");
      return file.stdout;
    };
    let content: string, encoding: "base64" | undefined, contentHash: string;
    if (args.format === "binary") {
      const stat = JSON.parse(await result(`${actionId}:stat`, { kind: "stat", path: args.path }));
      if (stat.type !== "file" || stat.size > 1000000 || !stat.sha256)
        throw new Error("Artifact must be a regular file up to 1 MB");
      const chunks: Buffer[] = [];
      for (let offset = 0; offset < stat.size; offset += 32768) {
        const part = JSON.parse(
          await result(`${actionId}:read:${offset}`, {
            kind: "read_bytes",
            path: args.path,
            offset,
            length: 32768,
          }),
        );
        if (part.totalBytes !== stat.size || part.sha256 !== stat.sha256)
          throw new Error("Artifact changed during snapshot");
        chunks.push(Buffer.from(part.base64, "base64"));
      }
      const bytes = Buffer.concat(chunks);
      contentHash = createHash("sha256").update(bytes).digest("hex");
      if (bytes.length !== stat.size || contentHash !== stat.sha256)
        throw new Error("Artifact snapshot mismatch");
      content = bytes.toString("base64");
      encoding = "base64";
    } else {
      content = await result(`${actionId}:read`, { kind: "read", path: args.path });
      contentHash = hash(content);
    }
    signal.throwIfAborted();
    s.assertRun(run);
    c.assertActionWork(run, workId);
    c.output.requireArtifactSupport(run.agentId, args.target);
    const artifact = {
      title: args.title,
      content,
      contentHash,
      filename: basename(args.path),
      ...(encoding ? { encoding } : {}),
    };
    return s.atomic(() => {
      const action = c.messages.writes.prepareAction(run, actionId, {
        kind: "artifact_draft",
        workId,
        args,
        contentHash: artifact.contentHash,
      });
      if (action.state === "succeeded") {
        const receipt = JSON.parse(action.receipt!);
        return gate.describe(run.agentId, receipt.draftId);
      }
      if (action.state !== "prepared") throw new Error("Publication preparation outcome unknown");
      // Changing target/action ID cannot resend an uncertain identical publication.
      if (
        s.db
          .prepare(
            "SELECT 1 FROM actions WHERE agent_id=? AND state IN ('unknown','executing') AND json_extract(request,'$.kind')='artifact' AND json_extract(request,'$.contentHash')=?",
          )
          .get(run.agentId, artifact.contentHash) ||
        s.db
          .prepare(
            "SELECT 1 FROM outbox WHERE agent_id=? AND state IN ('sending','unknown') AND json_extract(request,'$.artifact.contentHash')=?",
          )
          .get(run.agentId, artifact.contentHash)
      )
        throw new Error(
          "Artifact publication outcome unknown; inspect the destination before retry",
        );
      s.startAction(run, actionId);
      let result: unknown;
      if (args.draftId) {
        const previous = gate.describe(run.agentId, args.draftId) as { artifact?: unknown };
        if (!previous.artifact) throw new Error("Not an artifact draft");
        result = gate.revise(
          run,
          args.draftId,
          args.revision!,
          args.text ?? args.title,
          args.target,
          artifact,
        );
      } else {
        c.output.queueArtifact(
          run.agentId,
          args.target,
          args.text ?? args.title,
          artifact,
          actionId,
          { run, ...(args.viewToken ? { viewToken: args.viewToken } : {}) },
        );
        s.db.prepare("INSERT INTO output_work VALUES(?,?)").run(actionId, workId);
        result = gate.describe(run.agentId, actionId);
      }
      s.settleAction(run, actionId, "succeeded", result);
      return result;
    });
  }
}
