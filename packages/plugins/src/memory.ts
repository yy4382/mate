import { defineExtension, section, type Extension } from "@earendil-works/pi-durable";
import type { MemoryReadOutcome } from "@palace/node-protocol";

export type MemoryPort = {
  readMemory(signal: AbortSignal): Promise<MemoryReadOutcome | { readonly status: "offline" }>;
};

const MEMORY_GUIDANCE =
  "Memory directory rules:\n" +
  "- Persistent memory lives under ./memory/ in your home node workspace (also available as $PALACE_MEMORY_DIR in home shell commands).\n" +
  "- Organize notes, scripts, and topic files freely inside ./memory/.\n" +
  "- Only memory/MEMORY.md is loaded into your system prompt automatically; keep it concise and use it as your index.";

export function memoryExtension(
  port: MemoryPort,
  options: { readonly closing?: AbortSignal } = {},
): Extension {
  return defineExtension({
    name: "memory",
    sections: [
      section(
        "memory",
        async (input, context) => {
          const active = [options.closing, context.abortSignal].filter(
            (signal): signal is AbortSignal => signal !== undefined,
          );
          const signal =
            active.length === 0
              ? new AbortController().signal
              : active.length === 1
                ? active[0]!
                : AbortSignal.any(active);
          const outcome = await raceOfflineOnAbort(port.readMemory(signal), signal);
          if (outcome.status === "offline" || outcome.status === "unreadable") {
            const shown = input.shown["memory"];
            if (shown !== undefined) return shown;
            const statusText =
              outcome.status === "offline"
                ? "(home node is offline; memory/MEMORY.md could not be loaded)"
                : `(memory/MEMORY.md could not be read: ${outcome.message})`;
            return `<memory>\n${MEMORY_GUIDANCE}\n\n${statusText}\n</memory>`;
          }
          if (outcome.status === "missing") {
            return `<memory>\n${MEMORY_GUIDANCE}\n\n(memory/MEMORY.md does not exist yet.)\n</memory>`;
          }
          const truncationNote = outcome.truncated
            ? "\n\n[memory/MEMORY.md truncated after 64 KiB; move detail into topic files under ./memory/.]"
            : "";
          return `<memory>\n${MEMORY_GUIDANCE}\n\n<memory_index path="memory/MEMORY.md">\n${outcome.content}${truncationNote}\n</memory_index>\n</memory>`;
        },
        { tag: false },
      ),
    ],
  });
}

function raceOfflineOnAbort(
  read: Promise<MemoryReadOutcome | { readonly status: "offline" }>,
  signal: AbortSignal,
): Promise<MemoryReadOutcome | { readonly status: "offline" }> {
  if (signal.aborted) return Promise.resolve({ status: "offline" });
  const aborted = Promise.withResolvers<{ readonly status: "offline" }>();
  const onAbort = () => aborted.resolve({ status: "offline" });
  signal.addEventListener("abort", onAbort, { once: true });
  return Promise.race([read, aborted.promise]).finally(() =>
    signal.removeEventListener("abort", onAbort),
  );
}
