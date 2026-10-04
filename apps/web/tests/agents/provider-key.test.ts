// @vitest-environment jsdom
// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentsPage } from "../../src/features/agents/agents-page.js";

import { fixture, resetFixture, cleanupFixture } from "../support/agents-fixture.js";
beforeEach(resetFixture);
afterEach(cleanupFixture);

it("lets the owner save one provider key without displaying it again", async () => {
  const user = userEvent.setup();
  render(createElement(AgentsPage));
  await screen.findByRole("heading", { name: "模型服务凭据" });
  await user.selectOptions(screen.getByRole("combobox", { name: "模型服务" }), "anthropic");
  const syntheticKey = "synthetic-key-used-only-in-this-test";
  await user.type(screen.getByLabelText("API key"), syntheticKey);
  await user.click(screen.getByRole("button", { name: "保存或替换 API key" }));

  await waitFor(() =>
    expect(fixture.credentialWrites).toEqual([{ provider: "anthropic", apiKey: syntheticKey }]),
  );
  await screen.findByText("已配置");
  expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe("");
  expect(document.body.textContent?.includes(syntheticKey)).toBe(false);
  expect(screen.getByText("凭据已保存；服务列表不会显示 key。")).toBeTruthy();
});

vi.mock("../../src/features/agents/agents-page.css", () => ({}));
vi.mock("../../src/navigation.js", () => ({ redirectToLogin: vi.fn() }));
