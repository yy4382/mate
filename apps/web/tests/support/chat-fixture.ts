// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { expect, vi } from "vitest";
import { ChatPage } from "../../src/features/conversations/chat-page.js";

import { redirectToLogin } from "../../src/navigation.js";
class FixtureState {
  channels!: FixtureChannel[];
  history!: Map<string, FixtureMessage[]>;
  sessionStatus!: number;
  fetchMock!: ReturnType<typeof vi.fn>;
  posts!: Array<{ channelId: string; text: string }>;
  taskPosts!: Array<{ messageId?: string; title?: string; asTask?: boolean }>;
  tasks!: Array<{
    id: string;
    messageId: string;
    channelId: string;
    title: string;
    status: "open" | "in_progress" | "done";
    ownerAgentId: string | null;
    ownerAgentName?: string | null;
  }>;
  positionPosts!: Array<{ rootId?: string; quoteId?: string }>;
  nextPostGate!: {
    started: Promise<void>;
    signalStarted: () => void;
    waiting: Promise<void>;
    release: () => void;
  } | null;
  nextThreadGate!: {
    rootId: string;
    started: Promise<void>;
    signalStarted: () => void;
    response: Promise<Response>;
  } | null;
  nextHistoryGate!: {
    channelId: string;
    started: Promise<void>;
    signalStarted: () => void;
    response: Promise<Response>;
  } | null;
  attachments!: Array<{
    id: string;
    channelId: string;
    filename: string;
    contentType: string;
    size: number;
    sha256: string;
    uploader: { kind: "human"; id: "owner" } | { kind: "agent"; id: string };
    createdAt: number;
  }>;
  attachmentUploads!: Array<{ channelId: string; body: BodyInit | null; headers: Headers }>;
  failNextAttachmentUpload!: boolean;
  loseNextTaskResponse!: "network" | "invalid" | "malformed" | "unreadable" | "gateway" | null;
}
export const fixture = new FixtureState();
export interface FixtureChannel {
  id: string;
  name: string;
  description: string;
  visibility: "public" | "private";
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}
export interface FixtureMessage {
  id: string;
  channelId: string;
  rootId: null;
  author: { kind: "human"; id: "owner" } | { kind: "agent"; id: string };
  text: string;
  order: string;
  createdAt: number;
}
export class TestEventSource {
  static instances: TestEventSource[] = [];
  static messageOnConnect: { channelId: string; payload: FixtureMessage; seq: number } | undefined;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly listeners = new Map<string, Array<(event: Event) => void>>();
  closed = false;

  constructor(readonly url: string) {
    TestEventSource.instances.push(this);
    queueMicrotask(() => {
      this.onopen?.(new Event("open"));
      const message = TestEventSource.messageOnConnect;
      if (message) {
        TestEventSource.messageOnConnect = undefined;
        this.emit("message.created", {
          seq: message.seq,
          kind: "message.created",
          channelId: message.channelId,
          payload: message.payload,
        });
      }
    });
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data: unknown = {}): void {
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  fail(): void {
    this.onerror?.(new Event("error"));
  }
}
export const publicChannel: FixtureChannel = {
  id: "channel-public",
  name: "公开频道",
  description: "公开讨论",
  visibility: "public",
  archived: false,
  createdAt: 1,
  updatedAt: 1,
};
export const privateChannel: FixtureChannel = {
  id: "channel-private",
  name: "私有频道",
  description: "私人记录",
  visibility: "private",
  archived: false,
  createdAt: 2,
  updatedAt: 2,
};
export function delayNextPost(): { started: Promise<void>; release: () => void } {
  let signalStarted!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => (signalStarted = resolve));
  const waiting = new Promise<void>((resolve) => (release = resolve));
  fixture.nextPostGate = { started, signalStarted, waiting, release };
  return { started, release };
}
export function failNextLatestHistoryRequest(channelId: string): {
  started: Promise<void>;
  fail: () => void;
} {
  let signalStarted!: () => void, rejectResponse!: (response: Response) => void;
  const started = new Promise<void>((resolve) => (signalStarted = resolve));
  const response = new Promise<Response>((resolve) => (rejectResponse = resolve));
  fixture.nextHistoryGate = { channelId, started, signalStarted, response };
  return {
    started,
    fail: () => rejectResponse(json(503, { error: "读取频道 A 的最新消息失败" })),
  };
}
export function message(
  channelId: string,
  id: string,
  text: string,
  order: string,
): FixtureMessage {
  return {
    id,
    channelId,
    rootId: null,
    author: { kind: "human", id: "owner" },
    text,
    order,
    createdAt: Date.now(),
  };
}
export function json(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response;
}
export function installFetch(): void {
  fixture.fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/owner/session")
      return json(fixture.sessionStatus, { authenticated: fixture.sessionStatus === 200 });
    if (url === "/api/owner/snapshot") return json(200, { channels: fixture.channels, cursor: 0 });
    const attachmentMatch = url.match(
      /^\/api\/owner\/channels\/([^/]+)\/attachments(?:\/([^/]+)\/content)?$/,
    );
    if (attachmentMatch) {
      const channelId = decodeURIComponent(attachmentMatch[1]!);
      if (attachmentMatch[2]) return json(200, {});
      if (init?.method === "POST") {
        fixture.attachmentUploads.push({
          channelId,
          body: init.body ?? null,
          headers: new Headers(init.headers),
        });
        if (fixture.failNextAttachmentUpload) {
          fixture.failNextAttachmentUpload = false;
          return json(413, { error: "附件超过文件大小上限。" });
        }
        const upload = fixture.attachmentUploads.at(-1)!;
        const filename = decodeURIComponent(upload.headers.get("x-mate-filename") ?? "");
        const body = upload.body as File;
        const attachment = {
          id: `attachment-${fixture.attachmentUploads.length}`,
          channelId,
          filename,
          contentType: upload.headers.get("content-type") ?? "application/octet-stream",
          size: body.size,
          sha256: "sha256",
          uploader: { kind: "human" as const, id: "owner" as const },
          createdAt: Date.now(),
        };
        fixture.attachments.push(attachment);
        return json(201, { attachment });
      }
      return json(200, {
        attachments: fixture.attachments.filter((item) => item.channelId === channelId),
      });
    }
    if (url === "/api/owner/tasks") {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { messageId: string; title: string };
        const anchor = [...fixture.history.values()]
          .flat()
          .find((entry) => entry.id === body.messageId)!;
        fixture.taskPosts.push({ messageId: body.messageId, title: body.title });
        const task = {
          id: `task-${fixture.tasks.length + 1}`,
          messageId: anchor.id,
          channelId: anchor.channelId,
          title: body.title.trim(),
          status: "open" as const,
          ownerAgentId: null,
        };
        fixture.tasks.push(task);
        if (fixture.loseNextTaskResponse) {
          const fault = fixture.loseNextTaskResponse;
          fixture.loseNextTaskResponse = null;
          if (fault === "invalid") return json(201, null);
          if (fault === "malformed") return json(201, { ...task, status: "invalid" });
          if (fault === "unreadable") return new Response("invalid JSON", { status: 201 });
          if (fault === "gateway") return json(502, { error: "上游响应丢失" });
          throw new TypeError("Failed to fetch");
        }
        return json(201, task);
      }
      return json(200, { tasks: fixture.tasks });
    }
    const threadMatch = url.match(/^\/api\/owner\/channels\/([^/]+)\/threads\/([^/]+)/);
    if (threadMatch) {
      const gate = fixture.nextThreadGate;
      if (gate?.rootId === decodeURIComponent(threadMatch[2]!)) {
        fixture.nextThreadGate = null;
        gate.signalStarted();
        return gate.response;
      }
      const channelId = decodeURIComponent(threadMatch[1]!);
      const rootId = decodeURIComponent(threadMatch[2]!);
      const all = fixture.history.get(channelId) ?? [];
      const root = all.find((entry) => entry.id === rootId);
      return root
        ? json(200, { root, replies: all.filter((entry) => entry.rootId === rootId) })
        : json(404, { error: "Not found" });
    }
    const match = url.match(/^\/api\/owner\/channels\/([^/]+)\/messages/);
    if (match) {
      const channelId = decodeURIComponent(match[1]!);
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { text: string };
        const current = fixture.history.get(channelId) ?? [];
        const lastOrder = current.at(-1)?.order ?? "0";
        const created = message(
          channelId,
          `message-${fixture.posts.length + 1}`,
          body.text,
          String(BigInt(lastOrder) + 1n),
        );
        fixture.posts.push({ channelId, text: body.text });
        fixture.taskPosts.push({ asTask: (body as { asTask?: boolean }).asTask });
        if ((body as { asTask?: boolean }).asTask)
          fixture.tasks.push({
            id: `task-${fixture.tasks.length + 1}`,
            messageId: created.id,
            channelId,
            title: body.text,
            status: "open",
            ownerAgentId: null,
          });
        fixture.positionPosts.push({
          ...(typeof (body as { rootId?: string }).rootId === "string"
            ? { rootId: (body as { rootId: string }).rootId }
            : {}),
          ...(typeof (body as { quoteId?: string }).quoteId === "string"
            ? { quoteId: (body as { quoteId: string }).quoteId }
            : {}),
        });
        (created as FixtureMessage & { quoteId?: string }).rootId =
          (body as { rootId?: string }).rootId ?? null;
        (created as FixtureMessage & { quoteId?: string }).quoteId = (
          body as { quoteId?: string }
        ).quoteId;
        fixture.history.set(channelId, [...current, created]);
        const gate = fixture.nextPostGate;
        if (gate) {
          fixture.nextPostGate = null;
          gate.signalStarted();
          await gate.waiting;
        }
        return json(201, created);
      }
      const messages = (fixture.history.get(channelId) ?? []).filter((entry) => !entry.rootId),
        urlValue = new URL(url, "http://mate.test"),
        before = urlValue.searchParams.get("before");
      const gate = fixture.nextHistoryGate;
      if (before === null && gate?.channelId === channelId) {
        fixture.nextHistoryGate = null;
        fixture.nextThreadGate = null;
        gate.signalStarted();
        return gate.response;
      }
      const limit = Number(urlValue.searchParams.get("limit") ?? 50),
        eligible =
          before === null
            ? messages
            : messages.filter((entry) => BigInt(entry.order) < BigInt(before)),
        page = eligible.slice(-limit);
      return json(200, {
        messages: page,
        nextBefore: eligible.length > page.length ? (page[0]?.order ?? null) : null,
      });
    }
    return json(404, { error: "missing fixture route" });
  });
  vi.stubGlobal("fetch", fixture.fetchMock);
  vi.stubGlobal("EventSource", TestEventSource);
}
export async function openChat(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  render(createElement(ChatPage));
  await screen.findByRole("heading", { name: fixture.channels[0]!.name });
  await waitFor(() => expect(TestEventSource.instances).toHaveLength(1));
  return user;
}
export function resetFixture() {
  fixture.loseNextTaskResponse = null;
  window.history.replaceState({}, "", "/");
  fixture.channels = [publicChannel, privateChannel];
  fixture.history = new Map([
    [publicChannel.id, []],
    [privateChannel.id, []],
  ]);
  fixture.sessionStatus = 200;
  fixture.posts = [];
  fixture.attachments = [];
  fixture.attachmentUploads = [];
  fixture.failNextAttachmentUpload = false;
  fixture.taskPosts = [];
  fixture.tasks = [];
  fixture.positionPosts = [];
  fixture.nextPostGate = null;
  fixture.nextHistoryGate = null;
  fixture.nextThreadGate = null;
  TestEventSource.instances = [];
  TestEventSource.messageOnConnect = undefined;
  installFetch();
  vi.mocked(redirectToLogin).mockClear();
}
export function cleanupFixture() {
  cleanup();
  vi.unstubAllGlobals();
}
