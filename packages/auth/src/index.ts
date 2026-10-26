import { z } from "zod";

export const Role = z.enum(["admin", "member"]);
export type Role = z.infer<typeof Role>;

export const HumanView = z.object({
  accountId: z.number().int(),
  handle: z.string(),
  displayName: z.string(),
  role: Role,
  active: z.boolean(),
});
export type HumanView = z.infer<typeof HumanView>;

export const LoginInput = z.object({
  handle: z.string().max(256),
  password: z.string().max(1024),
  next: z.string().optional(),
});
export type LoginInput = z.infer<typeof LoginInput>;

export const LoginResult = z.object({ next: z.string() });
export type LoginResult = z.infer<typeof LoginResult>;
