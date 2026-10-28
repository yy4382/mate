import { Id } from "@mate/chat/contracts";
import { z } from "zod";

/** What a human may do: an admin manages Agents, providers, nodes and other humans; a member only chats. */
export const Role = z.enum(["admin", "member"]);
export type Role = z.output<typeof Role>;

/** A human as a client renders them: the chat account's names and the shell's role. */
export const HumanView = z.object({
  accountId: Id,
  handle: z.string(),
  displayName: z.string(),
  role: Role,
  active: z.boolean(),
});
export type HumanView = z.output<typeof HumanView>;

export const LoginInput = z.object({
  handle: z.string().max(256),
  password: z.string().max(1024),
  next: z.string().optional(),
});
export type LoginInput = z.output<typeof LoginInput>;

/** Where the client goes after logging in. */
export const LoginResult = z.object({ next: z.string() });
export type LoginResult = z.output<typeof LoginResult>;
