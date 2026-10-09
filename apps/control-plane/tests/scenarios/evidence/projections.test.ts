import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runScenario, ScenarioFailure } from "../../support/scenario/scenario-evidence.js";
import { createScriptedProvider } from "../../support/agent/scripted-provider.js";

import { ownerPassword } from "../../support/environment/run-services.js";
import { scriptedToolResultSchemas } from "../../support/agent/scripted-tool-results.js";

it("redacts credentials in synthetic effects and projections and refuses files outside its own workspaces", async () => {
  const root = mkdtempSync(join(tmpdir(), "mate-evidence-private-"));
  const original = new Error("synthetic privacy assertion");
  try {
    const provider = createScriptedProvider();
    const failure = await runScenario({
      name: "synthetic privacy",
      evidenceRoot: root,
      provider,
      environment: { agents: [{ name: "隐私证据同事" }] },
      async run({ environment, driver, effectFile }) {
        const agent = environment.agents[0];
        if (!agent) throw new Error("Expected prepared Agent");
        const synthetic = JSON.stringify({
          report: "total=12",
          password: ownerPassword,
          apiKey: "synthetic-control-only-key",
          downloadToken: "synthetic-download-secret",
          download_token: "synthetic-snake-download-secret",
          access_token: "synthetic-snake-access-secret",
          refresh_token: "synthetic-snake-refresh-secret",
          private_key: "synthetic-snake-private-secret",
          token: "synthetic-generic-token-secret",
          cookie: "synthetic-cookie-secret",
          privateKey:
            "-----BEGIN PRIVATE KEY-----\nsynthetic-private-secret\n-----END PRIVATE KEY-----",
        });
        provider.forAgent(agent, [
          function writeSyntheticFixture(request) {
            request.call("process.exec", { command: `printf '%s' '${synthetic}' > effect.json` });
          },
          function finishFixture(request) {
            request.text("合成数据已写入。");
          },
        ]);
        effectFile("effect.json", join(agent.workspace, "effect.json"));
        effectFile("forbidden-password", join(environment.directory, "owner-password"));
        const target = await driver.sendOwnerMessage(agent, "保存合成结果。");
        await driver.waitForRun(target, "completed");
        throw original;
      },
    }).catch((error: unknown) => error);
    if (!(failure instanceof ScenarioFailure)) throw new Error("Expected privacy evidence failure");
    expect(failure.cause).toBe(original);
    expect(failure.evidenceErrors).toHaveLength(1);
    expect(existsSync(join(failure.evidenceDirectory, "effects", "forbidden-password"))).toBe(
      false,
    );
    const files = readdirSync(failure.evidenceDirectory, { recursive: true }).filter(
      (name) => typeof name === "string" && (name.endsWith(".json") || name.endsWith(".txt")),
    );
    const evidence = files
      .map((name) => readFileSync(join(failure.evidenceDirectory, String(name)), "utf8"))
      .join("\n");
    for (const secret of [
      ownerPassword,
      "synthetic-control-only-key",
      "synthetic-download-secret",
      "synthetic-snake-download-secret",
      "synthetic-snake-access-secret",
      "synthetic-snake-refresh-secret",
      "synthetic-snake-private-secret",
      "synthetic-generic-token-secret",
      "synthetic-cookie-secret",
      "synthetic-private-secret",
    ])
      expect(evidence).not.toContain(secret);
    expect(evidence).toContain("total=12");
    expect(
      JSON.parse(readFileSync(join(failure.evidenceDirectory, "effects", "effect.json"), "utf8"))
        .downloadToken,
    ).toBe("[REDACTED]");
    expect(files.some((name) => String(name).includes("sqlite"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

it("preserves public channel messages and every thread reply rather than only the recent preview", async () => {
  const root = mkdtempSync(join(tmpdir(), "mate-evidence-thread-"));
  const original = new Error("original collaborative evidence assertion");
  let channelId = "";
  try {
    const failure = await runScenario({
      name: "public thread evidence",
      evidenceRoot: root,
      provider: createScriptedProvider(),
      async run({ environment }) {
        const channel = await (
          await environment.request("/api/owner/channels", {
            method: "POST",
            body: { name: "合成公开讨论", description: "合成证据", visibility: "public" },
          })
        ).json();
        channelId = channel.id;
        const rootMessage = await (
          await environment.request(`/api/owner/channels/${channelId}/messages`, {
            method: "POST",
            body: { text: "synthetic root" },
          })
        ).json();
        for (let index = 0; index < 5; index++)
          await environment.request(`/api/owner/channels/${channelId}/messages`, {
            method: "POST",
            body: { text: `synthetic reply ${index}`, rootId: rootMessage.id },
          });
        throw original;
      },
    }).catch((error: unknown) => error);
    if (!(failure instanceof ScenarioFailure)) throw new Error("Expected channel evidence failure");
    expect(failure.cause).toBe(original);
    const channel = JSON.parse(
      readFileSync(join(failure.evidenceDirectory, `channel-${channelId}.json`), "utf8"),
    );
    expect(channel.threads[0].replies.map((reply: { text: string }) => reply.text)).toEqual([
      "synthetic reply 0",
      "synthetic reply 1",
      "synthetic reply 2",
      "synthetic reply 3",
      "synthetic reply 4",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

it("exports node-local command and file receipts from real tool execution without copying its database", async () => {
  const root = mkdtempSync(join(tmpdir(), "mate-evidence-node-receipts-"));
  const original = new Error("original error after durable node receipts");
  let agentId = "";
  try {
    const provider = createScriptedProvider();
    const failure = await runScenario({
      name: "node receipts",
      evidenceRoot: root,
      provider,
      environment: { agents: [{ name: "本地收据同事" }] },
      async run({ environment, driver, effectFile }) {
        const agent = environment.agents[0];
        if (!agent) throw new Error("Expected prepared Agent");
        agentId = agent.summary.id;
        provider.forAgent(agent, [
          function writeInput(request) {
            request.call("workspace.write", { path: "input.txt", content: "2\n4\n6\n" });
          },
          function consumeRealInput(request) {
            request.call("process.exec", { command: "cat input.txt" });
          },
          function acknowledgeRealOutput(request) {
            expect(
              request.result("process.exec", scriptedToolResultSchemas["process.exec"]).receipt
                ?.stdout,
            ).toBe("2\n4\n6\n");
            request.text("真实文件与命令已完成。");
          },
        ]);
        effectFile("input.txt", join(agent.workspace, "input.txt"));
        const target = await driver.sendOwnerMessage(agent, "写入并读回合成数值。");
        await driver.waitForRun(target, "completed");
        throw original;
      },
    }).catch((error: unknown) => error);
    if (!(failure instanceof ScenarioFailure))
      throw new Error("Expected node receipt evidence failure");
    expect(failure.cause).toBe(original);
    const node = JSON.parse(
      readFileSync(join(failure.evidenceDirectory, "node-facts.json"), "utf8"),
    );
    expect(node.operations).toEqual([expect.objectContaining({ agentId, state: "succeeded" })]);
    expect(JSON.parse(node.operations[0].receipt).stdout).toBe("2\n4\n6\n");
    expect(node.fileReceipts).toEqual([
      expect.objectContaining({
        agentId,
        state: "succeeded",
        result: expect.objectContaining({ code: 0 }),
      }),
    ]);
    expect(readdirSync(failure.evidenceDirectory).some((name) => name.includes("sqlite"))).toBe(
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
