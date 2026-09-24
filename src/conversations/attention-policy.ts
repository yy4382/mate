import type { MessageDTO } from "../domain/messages.js";
/** Direct requests pierce ordinary mute; explicit defer and resolve remain independent. */
export function directRequest(actor: string, message: MessageDTO, kind: "channel" | "dm"): boolean {
  return (
    !message.deleted &&
    message.origin !== "system" &&
    !(message.author.kind === "agent" && message.author.id === actor) &&
    (kind === "dm" || message.mentions.some((p) => p.kind === "agent" && p.id === actor))
  );
}
