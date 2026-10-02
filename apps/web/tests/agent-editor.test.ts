// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement, useEffect, useState } from "react";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { AgentEditor } from "../src/features/agents/agent-editor.js";
import { agentSchema } from "../src/features/agents/agent-responses.js";
import { modelCredentialSummarySchema } from "@mate/protocol/owner";

const scheduler = vi.hoisted(() => {
  const immediate = globalThis.setImmediate;
  const pending: Array<() => void> = [];
  let hold = false;
  // React selects Node's scheduler when imported. Keep its real callbacks and handles,
  // but let the owner interact with the committed form before background work resumes.
  const interception = vi
    .spyOn(globalThis, "setImmediate")
    .mockImplementation((callback, ...args) =>
      immediate(() => {
        if (hold && document.querySelector('[aria-label="Partner 名称"]')) {
          pending.push(() => callback(...args));
        } else {
          callback(...args);
        }
      }),
    );
  return {
    hold() {
      hold = true;
    },
    release() {
      hold = false;
      pending.splice(0).forEach((callback) => callback());
    },
    restore() {
      interception.mockRestore();
    },
  };
});

const agent = agentSchema.parse({
  id: "agent-1",
  nodeId: "node-1",
  name: "Partner",
  role: "Researcher",
  description: "Old",
  model: { provider: "openai", id: "gpt-4.1" },
  status: "ready",
  stage: "complete",
  error: null,
  linuxIdentity: null,
});

function LoadedEditor() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void Promise.resolve().then(() => setReady(true));
  }, []);
  return ready
    ? createElement(AgentEditor, {
        agent,
        providers: [],
        credentials: [],
        refresh: async () => {},
      })
    : null;
}

afterEach(() => {
  scheduler.release();
  cleanup();
  vi.unstubAllGlobals();
});
afterAll(() => scheduler.restore());

it("saves the owner's replacement name when initial background synchronization follows clearing", async () => {
  const writes: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      writes.push({
        url: String(input),
        method: init?.method,
        body: JSON.parse(String(init?.body)),
      });
      return Response.json({});
    }),
  );
  scheduler.hold();
  const user = userEvent.setup();
  render(createElement(LoadedEditor));
  const name = await screen.findByRole("textbox", { name: "Partner 名称" });
  await user.clear(name);
  scheduler.release();
  await user.type(name, "Colleague");
  await user.click(screen.getByRole("button", { name: "保存名称" }));

  await waitFor(() =>
    expect(writes).toEqual([
      { url: "/api/owner/agents/agent-1/profile", method: "PATCH", body: { name: "Colleague" } },
    ]),
  );
});

it("saves profile fields and configured models separately and synchronizes later settings", async () => {
  const writes: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      writes.push({
        url: String(input),
        method: init?.method,
        body: JSON.parse(String(init?.body)),
      });
      return Response.json({});
    }),
  );
  const providers = [
    {
      id: "openai",
      name: "OpenAI",
      models: [
        { id: "gpt-4.1", name: "GPT-4.1" },
        { id: "gpt-4o-mini", name: "GPT-4o mini" },
      ],
    },
    {
      id: "anthropic",
      name: "Anthropic",
      models: [{ id: "claude-sonnet-4", name: "Claude Sonnet 4" }],
    },
  ];
  const credentials = modelCredentialSummarySchema
    .array()
    .parse([{ provider: "openai", configured: true, updatedAt: 1 }]);
  const props = { agent, providers, credentials, refresh: async () => {} };
  const view = render(createElement(AgentEditor, props));
  const user = userEvent.setup();

  await user.clear(screen.getByRole("textbox", { name: "Partner 名称" }));
  await user.type(screen.getByRole("textbox", { name: "Partner 名称" }), "Colleague");
  await user.click(screen.getByRole("button", { name: "保存名称" }));
  await user.clear(screen.getByRole("textbox", { name: "Partner 角色" }));
  await user.type(screen.getByRole("textbox", { name: "Partner 角色" }), "Reviewer");
  await user.click(screen.getByRole("button", { name: "保存角色" }));
  await user.clear(screen.getByRole("textbox", { name: "Partner 描述" }));
  await user.type(screen.getByRole("textbox", { name: "Partner 描述" }), "Checks reports");
  await user.click(screen.getByRole("button", { name: "保存描述" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "Partner 模型" }), "gpt-4o-mini");
  await user.click(screen.getByRole("button", { name: "切换模型" }));

  await waitFor(() =>
    expect(writes).toEqual([
      { url: "/api/owner/agents/agent-1/profile", method: "PATCH", body: { name: "Colleague" } },
      { url: "/api/owner/agents/agent-1/profile", method: "PATCH", body: { role: "Reviewer" } },
      {
        url: "/api/owner/agents/agent-1/profile",
        method: "PATCH",
        body: { description: "Checks reports" },
      },
      {
        url: "/api/owner/agents/agent-1/model",
        method: "PUT",
        body: { provider: "openai", id: "gpt-4o-mini" },
      },
    ]),
  );
  await user.selectOptions(screen.getByRole("combobox", { name: "Partner 模型服务" }), "anthropic");
  expect(screen.getByRole("button", { name: "切换模型" })).toHaveProperty("disabled", true);
  view.rerender(
    createElement(AgentEditor, {
      ...props,
      credentials: [
        ...credentials,
        modelCredentialSummarySchema.parse({
          provider: "anthropic",
          configured: true,
          updatedAt: 2,
        }),
      ],
    }),
  );
  expect(screen.getByRole("combobox", { name: "Partner 模型服务" })).toHaveProperty(
    "value",
    "anthropic",
  );
  await user.click(screen.getByRole("button", { name: "切换模型" }));
  await waitFor(() =>
    expect(writes.at(-1)).toEqual({
      url: "/api/owner/agents/agent-1/model",
      method: "PUT",
      body: { provider: "anthropic", id: "claude-sonnet-4" },
    }),
  );

  view.rerender(
    createElement(AgentEditor, {
      ...props,
      agent: {
        ...agent,
        name: "Updated partner",
        role: "Updated role",
        description: "Updated description",
        model: { provider: "openai", id: "gpt-4o-mini" },
      },
    }),
  );
  expect(screen.getByRole("textbox", { name: "Updated partner 名称" })).toHaveProperty(
    "value",
    "Updated partner",
  );
  expect(screen.getByRole("textbox", { name: "Updated partner 角色" })).toHaveProperty(
    "value",
    "Updated role",
  );
  expect(screen.getByRole("textbox", { name: "Updated partner 描述" })).toHaveProperty(
    "value",
    "Updated description",
  );
  expect(screen.getByRole("combobox", { name: "Updated partner 模型服务" })).toHaveProperty(
    "value",
    "openai",
  );
  expect(screen.getByRole("combobox", { name: "Updated partner 模型" })).toHaveProperty(
    "value",
    "gpt-4o-mini",
  );
  for (const name of ["保存名称", "保存角色", "保存描述", "切换模型"]) {
    expect(screen.getByRole("button", { name })).toHaveProperty("disabled", true);
  }
});
