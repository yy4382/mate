import type { MemoryReadOutcome } from "@palace/node-protocol";
import { describe, expect, it } from "vitest";
import { memoryExtension, type MemoryPort } from "../src/memory.ts";
import { testAgent } from "./support.ts";

describe("memory extension", () => {
  it("loads memory/MEMORY.md directly with <memory> root tags and directory guidance, and preserves prior memory when offline", async () => {
    let outcome: MemoryReadOutcome | { readonly status: "offline" } = {
      status: "ok",
      content: "- user prefers pnpm\n",
      truncated: false,
    };
    const port: MemoryPort = { readMemory: async () => outcome };
    const agent = await testAgent();

    let firstSystem = "";
    let thirdSystem = "";
    agent.provider
      .step("first", (request) => {
        firstSystem = request.systemTexts().join("\n");
        request.text("ok");
      })
      .step("second offline", (request) => {
        expect(request.systemTexts().join("\n")).toBe(firstSystem);
        request.text("still remember");
      })
      .step("third missing", (request) => {
        thirdSystem = request.systemTexts().join("\n");
        request.text("no memory file");
      });

    const { runtime } = await agent.open({ extensions: [memoryExtension(port)] });
    await (await runtime.submit("hi", { requestId: "m1" })).settled();

    expect(firstSystem).toContain("<memory>");
    expect(firstSystem).not.toContain("<memory>\n<memory>");
    expect(firstSystem).toContain("./memory/");
    expect(firstSystem).toContain("$PALACE_MEMORY_DIR");
    expect(firstSystem).toContain("memory/MEMORY.md");
    expect(firstSystem).toContain("- user prefers pnpm");

    // When home node goes offline later, keep previously shown memory so prompt cache stays intact.
    outcome = { status: "offline" };
    await (await runtime.submit("offline check", { requestId: "m2" })).settled();

    // When memory file is missing from a clean start or after deletion, show missing state clearly.
    outcome = { status: "missing" };
    await (await runtime.submit("missing check", { requestId: "m3" })).settled();
    expect(thirdSystem).toContain("memory/MEMORY.md does not exist yet");
    agent.provider.assertComplete();
  });
});
