// @vitest-environment jsdom
// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  fixture,
  publicChannel,
  privateChannel,
  delayNextPost,
  message,
  openChat,
  resetFixture,
  cleanupFixture,
} from "../support/chat-fixture.js";
beforeEach(resetFixture);
afterEach(cleanupFixture);

it("keeps channel drafts separate and clears only the successfully sent draft", async () => {
  const user = await openChat();
  const publicDraft = screen.getByRole("textbox", { name: "发送到 公开频道" });
  await user.type(publicDraft, "公开草稿");
  await user.click(screen.getByRole("button", { name: /私有频道/ }));
  const privateDraft = screen.getByRole("textbox", { name: "发送到 私有频道" });
  await user.type(privateDraft, "私有草稿");

  await user.click(screen.getByRole("button", { name: /公开频道/ }));
  expect(
    (screen.getByRole("textbox", { name: "发送到 公开频道" }) as HTMLTextAreaElement).value,
  ).toBe("公开草稿");
  await user.click(screen.getByRole("button", { name: /私有频道/ }));
  expect(
    (screen.getByRole("textbox", { name: "发送到 私有频道" }) as HTMLTextAreaElement).value,
  ).toBe("私有草稿");
  await user.click(screen.getByRole("button", { name: "发送" }));

  await waitFor(() =>
    expect(fixture.posts).toEqual([{ channelId: privateChannel.id, text: "私有草稿" }]),
  );
  expect(
    (screen.getByRole("textbox", { name: "发送到 私有频道" }) as HTMLTextAreaElement).value,
  ).toBe("");
  await user.click(screen.getByRole("button", { name: /公开频道/ }));
  expect(
    (screen.getByRole("textbox", { name: "发送到 公开频道" }) as HTMLTextAreaElement).value,
  ).toBe("公开草稿");
});

it("preserves text typed during an in-flight send after the submitted message succeeds", async () => {
  const user = await openChat();
  const draft = screen.getByRole("textbox", { name: "发送到 公开频道" });
  await user.type(draft, "提交 A");
  const gate = delayNextPost();

  await user.click(screen.getByRole("button", { name: "发送" }));
  await gate.started;
  await user.type(draft, "期间输入 B");
  gate.release();

  expect(await screen.findByText("提交 A")).not.toBeNull();
  expect(fixture.posts).toEqual([{ channelId: publicChannel.id, text: "提交 A" }]);
  expect(
    (screen.getByRole("textbox", { name: "发送到 公开频道" }) as HTMLTextAreaElement).value,
  ).toBe("提交 A期间输入 B");
});

vi.mock("../../src/navigation.js", () => ({ redirectToLogin: vi.fn() }));
