import { slackPrincipal } from "./principals.js";
import { z } from "zod";
import type { MateConfig } from "../config.js";
import { References } from "../conversations/references.js";
import { conversationTargetSchema } from "../domain/conversations.js";
import { LegacyConversationCodec } from "./legacy-codec.js";
import { encode } from "../storage/store.js";
const oldMessage = z.object({ channel: z.string(), ts: z.string() }).strict();
const messageRef = z.object({ messageId: z.string().min(1) }).strict();
const object = z.record(z.string(), z.unknown());

/** The only input compatibility boundary for pre-v2 tool references. It never grants access. */
export class LegacyArguments {
  private readonly codec: LegacyConversationCodec;
  constructor(
    private readonly refs: References,
    private readonly config: MateConfig,
  ) {
    this.codec = new LegacyConversationCodec(refs, config);
  }
  private message(value: unknown): unknown {
    const input = object.parse(value);
    if (Object.hasOwn(input, "messageId")) {
      const canonical = messageRef.parse(input);
      this.refs.message(canonical.messageId);
      return canonical;
    }
    const old = oldMessage.parse(input),
      id = this.refs.findMessage({
        provider: "slack",
        workspace: this.config.teamId,
        externalId: old.channel,
        messageId: old.ts,
      });
    if (!id) throw new Error("Legacy message reference missing");
    return { messageId: id };
  }
  args(value: unknown): Record<string, unknown> {
    const args = { ...object.parse(value) };
    if (args.target) {
      const target = object.parse(args.target);
      args.target = Object.hasOwn(target, "conversationId")
        ? this.refs.validateTarget(conversationTargetSchema.parse(target))
        : this.codec.target(target);
    }
    for (const field of ["message", "anchor"])
      if (args[field]) args[field] = this.message(args[field]);
    if (Object.hasOwn(args, "channel")) {
      if (Object.hasOwn(args, "conversationId"))
        throw new Error("Mixed legacy and canonical conversation arguments");
      const target = this.codec.target({ channel: args.channel });
      delete args.channel;
      args.conversationId = target.conversationId;
    }
    if (Object.hasOwn(args, "user")) {
      if (Object.hasOwn(args, "principal"))
        throw new Error("Mixed legacy and canonical principal arguments");
      const user = z
        .string()
        .regex(/^U[A-Z0-9]+$/)
        .parse(args.user);
      delete args.user;
      args.principal = slackPrincipal(this.config, user);
    }
    return args;
  }
  effect(value: unknown): Record<string, unknown> {
    const request = { ...object.parse(value) };
    if (Object.hasOwn(request, "format")) {
      if (request.format !== "mate.effect.v2") throw new Error("Unsupported stored effect format");
      delete request.format;
      return request;
    }
    if (request.args) request.args = this.args(request.args);
    if (request.target) request.target = this.codec.target(request.target);
    if (Object.hasOwn(request, "user")) return this.args(request);
    return request;
  }
}
