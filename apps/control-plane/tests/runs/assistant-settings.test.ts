import type { ServerResponse } from "node:http";
import { expect, it } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { loopFixture, respond, type ProviderRequest } from "../support/agent/agent-loop.js";
import { eventually } from "../support/environment/run-services.js";
import { inspectSession } from "../../src/prompts/inspection.js";

it("updates primary and assistant requests together without changing their input or provider identities", async () => {
  const roots: {
    request: ProviderRequest;
    response: ServerResponse;
    authorization: string | undefined;
  }[] = [];
  const children: typeof roots = [];
  let finish = false;
  const fixture = await loopFixture((request, response, http) => {
    if (finish) return respond(response, "完成");
    const first = JSON.stringify(request.input.filter((item) => item.role === "user")[0]);
    (first.includes("settings-child") ? children : roots).push({
      request,
      response,
      authorization: http.headers.authorization,
    });
  });
  try {
    const agent = await fixture.agent("设置同事", { provider: "openai", id: "gpt-5-mini" });
    const model = (thinkingLevel: string, id = "gpt-5-mini") =>
      fixture.api(`/api/owner/agents/${agent.id}/model`, "PUT", {
        provider: "openai",
        id,
        thinkingLevel,
      });
    await model("low");
    await fixture.send(agent.channelId, "PRIMARY_SETTINGS_INPUT");
    const initial = await eventually(() => roots[0], "initial low primary");
    expect(initial.request.reasoning).toMatchObject({ effort: "low" });
    respond(initial.response, [
      {
        name: "tools.call",
        input: {
          name: "spawn_agent",
          input: { task_name: "settings", message: "settings-child", fork_turns: "none" },
        },
      },
    ]);
    const child = await eventually(() => children[0], "initial low assistant");
    await eventually(() => roots[1], "primary after spawn");
    expect(child.request.reasoning).toMatchObject({ effort: "low" });
    await model("high");
    const highRoot = await eventually(() => roots[2], "high primary");
    const highChild = await eventually(() => children[1], "high assistant");
    expect(highRoot.request.reasoning).toMatchObject({ effort: "high" });
    expect(highChild.request.reasoning).toMatchObject({ effort: "high" });
    const file = join(fixture.directory, "control-plane-data", "durable", `${agent.id}.sqlite`);
    expect(await inspectSession(file)).toMatchObject({
      configuredThinkingLevel: "high",
      requestThinkingLevel: "low",
    });
    expect(child.response.destroyed).toBe(true);
    await fixture.restartControl();
    const restoredRoot = await eventually(() => roots[3], "restored high primary");
    const restoredChild = await eventually(() => children[2], "restored high assistant");
    expect(restoredRoot.request.reasoning).toMatchObject({ effort: "high" });
    expect(restoredChild.request.reasoning).toMatchObject({ effort: "high" });
    await model("default");
    const defaultRoot = await eventually(() => roots[4], "default primary");
    const defaultChild = await eventually(() => children[3], "default assistant");
    expect(defaultRoot.request.reasoning).toBeUndefined();
    expect(defaultChild.request.reasoning).toBeUndefined();
    await fixture.api("/api/owner/model-credentials/openai", "PUT", {
      apiKey: "synthetic-rotated-key",
    });
    const keyedRoot = await eventually(() => roots[5], "rotated primary");
    const keyedChild = await eventually(() => children[4], "rotated assistant");
    expect(keyedRoot.authorization).toBe("Bearer synthetic-rotated-key");
    expect(keyedChild.authorization).toBe("Bearer synthetic-rotated-key");
    await model("default", "gpt-4.1-mini");
    const changedRoot = await eventually(() => roots[6], "changed primary model");
    const changedChild = await eventually(() => children[5], "changed assistant model");
    expect(changedRoot.request.model).toBe("gpt-4.1-mini");
    expect(changedChild.request.model).toBe("gpt-4.1-mini");
    for (const { request } of roots) {
      expect(request.prompt_cache_key).toBe(initial.request.prompt_cache_key);
      expect(JSON.stringify(request.input).split("PRIMARY_SETTINGS_INPUT")).toHaveLength(2);
    }
    for (const { request } of children) {
      expect(request.prompt_cache_key).toBe(child.request.prompt_cache_key);
      expect(JSON.stringify(request.input).split("settings-child")).toHaveLength(2);
    }
    finish = true;
    respond(changedChild.response, [
      {
        name: "tools.call",
        input: {
          name: "process.exec",
          input: { command: "printf 'once\\n' >> settings-ledger.txt" },
        },
      },
    ]);
    respond(changedRoot.response, "父完成");
    await fixture.completed(agent.id);
    expect(readFileSync(join(agent.workspace, "settings-ledger.txt"), "utf8")).toBe("once\n");
    expect(await inspectSession(file)).toMatchObject({
      configuredThinkingLevel: "default",
      requestThinkingLevel: "off",
    });
  } finally {
    await fixture.close();
  }
}, 30000);

it.each(["model", "thinking", "credentials"])(
  "replaces an old prepared assistant request after %s changes and a control-plane crash",
  async (change) => {
    const children: { request: ProviderRequest; authorization: string | undefined }[] = [];
    const fixture = await loopFixture((request, response, http) => {
      const first = JSON.stringify(request.input.filter((item) => item.role === "user")[0]);
      const input = JSON.stringify(request.input);
      if (first.includes("prepared-settings-child")) {
        children.push({ request, authorization: http.headers.authorization });
        if (input.includes("function_call_output")) respond(response, "prepared助手完成");
        else
          respond(response, [
            {
              name: "tools.call",
              input: {
                name: "process.exec",
                input: { command: "printf 'once\\n' >> prepared-settings.txt" },
              },
            },
          ]);
      } else if (input.includes("function_call_output") || input.includes("[助手完成回报]"))
        respond(response, "主完成");
      else
        respond(response, [
          {
            name: "tools.call",
            input: {
              name: "spawn_agent",
              input: {
                task_name: "prepared",
                message: "prepared-settings-child",
                fork_turns: "none",
              },
            },
          },
        ]);
    }, `, afterDurableCommit: async writes => { if (writes.some(write => write.type === "task" && write.value.kind === "pi.generation" && write.value.conversationId !== 1 && write.value.state.status === "running" && write.value.state.checkpoint.phase === "request")) { console.log("CHILD_REQUEST_PREPARED"); await new Promise(() => {}); } }`);
    try {
      const agent = await fixture.agent("prepared设置", { provider: "openai", id: "gpt-5-mini" });
      await fixture.api(`/api/owner/agents/${agent.id}/model`, "PUT", {
        provider: "openai",
        id: "gpt-5-mini",
        thinkingLevel: "low",
      });
      await fixture.send(agent.channelId, "prepared后配置更新");
      await fixture.control.waitFor(/CHILD_REQUEST_PREPARED/);
      expect(children).toHaveLength(0);
      if (change === "credentials")
        await fixture.api("/api/owner/model-credentials/openai", "PUT", {
          apiKey: "synthetic-prepared-updated",
        });
      else
        await fixture.api(`/api/owner/agents/${agent.id}/model`, "PUT", {
          provider: "openai",
          id: change === "model" ? "gpt-5" : "gpt-5-mini",
          thinkingLevel: change === "thinking" ? "high" : "low",
        });
      await fixture.restartControl();
      await eventually(() => children[1], "recovered assistant and command result");
      await fixture.completed(agent.id);
      expect(children[0]!.request.model).toBe(change === "model" ? "gpt-5" : "gpt-5-mini");
      expect(children[0]!.request.reasoning).toMatchObject({
        effort: change === "thinking" ? "high" : "low",
      });
      expect(children[0]!.authorization).toBe(
        change === "credentials"
          ? "Bearer synthetic-prepared-updated"
          : "Bearer synthetic-control-only-key",
      );
      expect(
        JSON.stringify(children[0]!.request.input).split("prepared-settings-child"),
      ).toHaveLength(2);
      expect(children[1]!.request.prompt_cache_key).toBe(children[0]!.request.prompt_cache_key);
      expect(readFileSync(join(agent.workspace, "prepared-settings.txt"), "utf8")).toBe("once\n");
    } finally {
      await fixture.close();
    }
  },
  30000,
);
