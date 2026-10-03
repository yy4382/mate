// @vitest-environment jsdom
// @vitest-environment jsdom
import { act, screen, waitFor } from "@testing-library/react";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { redirectToLogin } from "../../src/navigation.js";
import {
  fixture,
  TestEventSource,
  openChat,
  resetFixture,
  cleanupFixture,
} from "../support/chat-fixture.js";
beforeEach(resetFixture);
afterEach(cleanupFixture);

it("clears private chat and requests login when session revalidation gets 401", async () => {
  const user = await openChat();
  await user.click(screen.getByRole("button", { name: /私有频道/ }));
  await screen.findByRole("heading", { name: "私有频道" });
  expect(screen.getByText("私人记录")).not.toBeNull();
  fixture.sessionStatus = 401;

  act(() => TestEventSource.instances[0]!.fail());

  await waitFor(() => expect(redirectToLogin).toHaveBeenCalledOnce());
  expect(screen.queryByText("私人记录")).toBeNull();
  expect(screen.queryByRole("button", { name: /私有频道/ })).toBeNull();
  expect(TestEventSource.instances[0]!.closed).toBe(true);
});

it("traps modal focus, closes on Escape, and restores focus to its opener", async () => {
  const user = await openChat();
  const opener = screen.getByRole("button", { name: "新建频道" });
  await user.click(opener);
  const name = screen.getByRole("textbox", { name: "频道名称" });
  expect(document.activeElement).toBe(name);
  await user.type(name, "新频道");

  await user.tab({ shift: true });
  const closeButton = screen.getByRole("button", { name: "关闭" });
  expect(document.activeElement).toBe(closeButton);
  await user.tab({ shift: true });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "创建频道" }));

  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(opener);
});

vi.mock("../../src/features/conversations/chat.css", () => ({}));
vi.mock("../../src/navigation.js", () => ({ redirectToLogin: vi.fn() }));
