import { isAbsolute } from "node:path";
import { z } from "zod";

/** Shape shared by the control-plane approval request and the privileged node backend. */
export const systemCommandSchema = z
  .object({
    program: z.string().min(1).max(4096).refine(isAbsolute),
    args: z.array(z.string().max(4096)).max(100),
    cwd: z.string().min(1).max(4096).refine(isAbsolute),
  })
  .strict()
  .refine(
    (command) => JSON.stringify(command).length <= 2400,
    "System request exceeds approval UI capacity",
  );

export type SystemCommand = z.infer<typeof systemCommandSchema>;

export interface PrivilegedExecutor {
  execute(
    command: SystemCommand,
    signal?: AbortSignal,
  ): Promise<{ code: number; stdout: string; stderr: string; truncated: boolean }>;
}
