import { z } from "zod";

// Even JSON-escaped UTF-16 characters fit comfortably within the 1 MiB wire frame.
export const sessionFragmentCharacters = 64 * 1024;
export const sessionFragmentSchema = z
  .object({
    kind: z.literal("fragment"),
    offset: z.number().int().nonnegative().safe(),
    total: z.number().int().positive().safe(),
    data: z.string().min(1).max(sessionFragmentCharacters),
  })
  .strict();
export type SessionFragment = z.infer<typeof sessionFragmentSchema>;

export function sessionFragment(serialized: string, offset: number): SessionFragment {
  return {
    kind: "fragment",
    offset,
    total: serialized.length,
    data: serialized.slice(offset, offset + sessionFragmentCharacters),
  };
}

/** Only one in-flight complete message per authorized run; retries never grow the buffer twice. */
export class SessionAssembly {
  private chunks: string[] = [];
  private length = 0;
  constructor(
    readonly id: string,
    private readonly total: number,
  ) {}

  accept(id: string, part: SessionFragment): string | undefined {
    if (
      id !== this.id ||
      part.total !== this.total ||
      part.offset !== this.length ||
      part.offset + part.data.length > this.total
    )
      throw new Error("Out-of-order session fragment");
    this.chunks.push(part.data);
    this.length += part.data.length;
    if (this.length !== this.total) return undefined;
    return this.chunks.join("");
  }
}
