// @vitest-environment jsdom
// @vitest-environment jsdom
import { screen } from "@testing-library/react";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  fixture,
  publicChannel,
  openChat,
  resetFixture,
  cleanupFixture,
} from "../support/chat-fixture.js";
beforeEach(resetFixture);
afterEach(cleanupFixture);

it("uploads attachments as the original File stream and lists owner and Agent files with downloads", async () => {
  fixture.attachments = [
    {
      id: "agent-file",
      channelId: publicChannel.id,
      filename: "agent-report.txt",
      contentType: "text/plain",
      size: 12,
      sha256: "digest",
      uploader: { kind: "agent", id: "agent-1" },
      createdAt: 1,
    },
  ];
  const user = await openChat();
  await screen.findByText("agent-report.txt");
  const input = screen.getByLabelText("添加附件") as HTMLInputElement,
    file = new File(["hello"], "研究笔记.txt", { type: "text/plain" });
  await user.upload(input, file);
  await user.click(screen.getByRole("button", { name: "上传附件" }));

  await screen.findByText("研究笔记.txt");
  expect(fixture.attachmentUploads).toHaveLength(1);
  expect(fixture.attachmentUploads[0]?.body).toBe(file);
  expect(fixture.attachmentUploads[0]?.headers.get("content-type")).toBe("text/plain");
  expect(fixture.attachmentUploads[0]?.headers.get("x-mate-filename")).toBe(
    encodeURIComponent("研究笔记.txt"),
  );
  expect(screen.getByRole("link", { name: /agent-report.txt/ }).getAttribute("href")).toBe(
    `/api/owner/channels/${publicChannel.id}/attachments/agent-file/content`,
  );
  expect(screen.getByRole("link", { name: /研究笔记.txt/ }).getAttribute("href")).toBe(
    `/api/owner/channels/${publicChannel.id}/attachments/attachment-1/content`,
  );
});

it("shows a useful upload failure and lets the owner retry without losing the selected file", async () => {
  const user = await openChat();
  const file = new File(["hello"], "notes.txt", { type: "text/plain" });
  await user.upload(screen.getByLabelText("添加附件"), file);
  fixture.failNextAttachmentUpload = true;
  await user.click(screen.getByRole("button", { name: "上传附件" }));

  expect(await screen.findByRole("alert")).not.toBeNull();
  expect(screen.getByRole("alert").textContent).toContain("附件超过文件大小上限");
  expect((screen.getByLabelText("添加附件") as HTMLInputElement).files?.[0]).toBe(file);
  await user.click(screen.getByRole("button", { name: "上传附件" }));
  expect(await screen.findByText("notes.txt")).not.toBeNull();
  expect(fixture.attachmentUploads).toHaveLength(2);
  expect(fixture.attachmentUploads[1]?.body).toBe(file);
});

vi.mock("../../src/navigation.js", () => ({ redirectToLogin: vi.fn() }));
