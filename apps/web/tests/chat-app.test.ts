// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatPage } from "../src/chat-app.js";
import { redirectToLogin } from "../src/navigation.js";

vi.mock("../src/chat.css", () => ({}));
vi.mock("../src/navigation.js", () => ({ redirectToLogin: vi.fn() }));

interface FixtureChannel {
  id: string;
  name: string;
  description: string;
  visibility: "public" | "private";
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

interface FixtureMessage {
  id: string;
  channelId: string;
  rootId: null;
  author: { kind: "human"; id: "owner" } | { kind: "agent"; id: string };
  text: string;
  order: string;
  revision: string;
  createdAt: number;
}

class TestEventSource {
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

const publicChannel: FixtureChannel = {
  id: "channel-public",
  name: "公开频道",
  description: "公开讨论",
  visibility: "public",
  archived: false,
  createdAt: 1,
  updatedAt: 1,
};
const privateChannel: FixtureChannel = {
  id: "channel-private",
  name: "私有频道",
  description: "私人记录",
  visibility: "private",
  archived: false,
  createdAt: 2,
  updatedAt: 2,
};

let channels: FixtureChannel[];
let history: Map<string, FixtureMessage[]>;
let sessionStatus: number;
let fetchMock: ReturnType<typeof vi.fn>;
let posts: Array<{ channelId: string; text: string }>;
let taskPosts: Array<{ messageId?: string; asTask?: boolean }>;
let tasks: Array<{
  id: string;
  messageId: string;
  channelId: string;
  title: string;
  status: "open";
  ownerAgentId: null;
}>;
let positionPosts: Array<{ rootId?: string; quoteId?: string }>;
let nextPostGate: {
  started: Promise<void>;
  signalStarted: () => void;
  waiting: Promise<void>;
  release: () => void;
} | null;
let nextThreadGate: {
  rootId: string;
  started: Promise<void>;
  signalStarted: () => void;
  response: Promise<Response>;
} | null;
let nextHistoryGate: {
  channelId: string;
  started: Promise<void>;
  signalStarted: () => void;
  response: Promise<Response>;
} | null;
let attachments: Array<{
  id: string;
  channelId: string;
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
  uploader: { kind: "human"; id: "owner" } | { kind: "agent"; id: string };
  createdAt: number;
}>;
let attachmentUploads: Array<{ channelId: string; body: BodyInit | null; headers: Headers }>;
let failNextAttachmentUpload: boolean;

function delayNextPost(): { started: Promise<void>; release: () => void } {
  let signalStarted!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => (signalStarted = resolve));
  const waiting = new Promise<void>((resolve) => (release = resolve));
  nextPostGate = { started, signalStarted, waiting, release };
  return { started, release };
}

function failNextLatestHistoryRequest(channelId: string): {
  started: Promise<void>;
  fail: () => void;
} {
  let signalStarted!: () => void, rejectResponse!: (response: Response) => void;
  const started = new Promise<void>((resolve) => (signalStarted = resolve));
  const response = new Promise<Response>((resolve) => (rejectResponse = resolve));
  nextHistoryGate = { channelId, started, signalStarted, response };
  return {
    started,
    fail: () => rejectResponse(json(503, { error: "读取频道 A 的最新消息失败" })),
  };
}

function message(channelId: string, id: string, text: string, order: string): FixtureMessage {
  return {
    id,
    channelId,
    rootId: null,
    author: { kind: "human", id: "owner" },
    text,
    order,
    revision: "1",
    createdAt: Date.now(),
  };
}

function json(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response;
}

function installFetch(): void {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/owner/session")
      return json(sessionStatus, { authenticated: sessionStatus === 200 });
    if (url === "/api/owner/snapshot") return json(200, { channels, cursor: 0 });
    const attachmentMatch = url.match(
      /^\/api\/owner\/channels\/([^/]+)\/attachments(?:\/([^/]+)\/content)?$/,
    );
    if (attachmentMatch) {
      const channelId = decodeURIComponent(attachmentMatch[1]!);
      if (attachmentMatch[2]) return json(200, {});
      if (init?.method === "POST") {
        attachmentUploads.push({
          channelId,
          body: init.body ?? null,
          headers: new Headers(init.headers),
        });
        if (failNextAttachmentUpload) {
          failNextAttachmentUpload = false;
          return json(413, { error: "附件超过文件大小上限。" });
        }
        const upload = attachmentUploads.at(-1)!;
        const filename = decodeURIComponent(upload.headers.get("x-mate-filename") ?? "");
        const body = upload.body as File;
        const attachment = {
          id: `attachment-${attachmentUploads.length}`,
          channelId,
          filename,
          contentType: upload.headers.get("content-type") ?? "application/octet-stream",
          size: body.size,
          sha256: "sha256",
          uploader: { kind: "human" as const, id: "owner" as const },
          createdAt: Date.now(),
        };
        attachments.push(attachment);
        return json(201, { attachment });
      }
      return json(200, { attachments: attachments.filter((item) => item.channelId === channelId) });
    }
    if (url === "/api/owner/tasks") {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { messageId: string };
        const anchor = [...history.values()].flat().find((entry) => entry.id === body.messageId)!;
        taskPosts.push({ messageId: body.messageId });
        const task = {
          id: `task-${tasks.length + 1}`,
          messageId: anchor.id,
          channelId: anchor.channelId,
          title: anchor.text,
          status: "open" as const,
          ownerAgentId: null,
        };
        tasks.push(task);
        return json(201, task);
      }
      return json(200, { tasks });
    }
    const threadMatch = url.match(/^\/api\/owner\/channels\/([^/]+)\/threads\/([^/]+)/);
    if (threadMatch) {
      const gate = nextThreadGate;
      if (gate?.rootId === decodeURIComponent(threadMatch[2]!)) {
        nextThreadGate = null;
        gate.signalStarted();
        return gate.response;
      }
      const channelId = decodeURIComponent(threadMatch[1]!);
      const rootId = decodeURIComponent(threadMatch[2]!);
      const all = history.get(channelId) ?? [];
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
        const current = history.get(channelId) ?? [];
        const lastOrder = current.at(-1)?.order ?? "0";
        const created = message(
          channelId,
          `message-${posts.length + 1}`,
          body.text,
          String(BigInt(lastOrder) + 1n),
        );
        posts.push({ channelId, text: body.text });
        taskPosts.push({ asTask: (body as { asTask?: boolean }).asTask });
        if ((body as { asTask?: boolean }).asTask)
          tasks.push({
            id: `task-${tasks.length + 1}`,
            messageId: created.id,
            channelId,
            title: body.text,
            status: "open",
            ownerAgentId: null,
          });
        positionPosts.push({
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
        history.set(channelId, [...current, created]);
        const gate = nextPostGate;
        if (gate) {
          nextPostGate = null;
          gate.signalStarted();
          await gate.waiting;
        }
        return json(201, created);
      }
      const messages = (history.get(channelId) ?? []).filter((entry) => !entry.rootId),
        urlValue = new URL(url, "http://mate.test"),
        before = urlValue.searchParams.get("before");
      const gate = nextHistoryGate;
      if (before === null && gate?.channelId === channelId) {
        nextHistoryGate = null;
        nextThreadGate = null;
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
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", TestEventSource);
}

async function openChat(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  render(createElement(ChatPage));
  await screen.findByRole("heading", { name: channels[0]!.name });
  await waitFor(() => expect(TestEventSource.instances).toHaveLength(1));
  return user;
}

beforeEach(() => {
  window.history.replaceState({}, "", "/");
  channels = [publicChannel, privateChannel];
  history = new Map([
    [publicChannel.id, []],
    [privateChannel.id, []],
  ]);
  sessionStatus = 200;
  posts = [];
  attachments = [];
  attachmentUploads = [];
  failNextAttachmentUpload = false;
  taskPosts = [];
  tasks = [];
  positionPosts = [];
  nextPostGate = null;
  nextHistoryGate = null;
  nextThreadGate = null;
  TestEventSource.instances = [];
  TestEventSource.messageOnConnect = undefined;
  installFetch();
  vi.mocked(redirectToLogin).mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("keeps an Agent DM event that arrives as the initial selected channel is being restored", async () => {
  window.history.replaceState({}, "", `/app?channel=${privateChannel.id}`);
  TestEventSource.messageOnConnect = {
    channelId: privateChannel.id,
    seq: 1,
    payload: {
      ...message(privateChannel.id, "initial-agent-reply", "初始连接期间的 Agent 回复", "1"),
      author: { kind: "agent", id: "agent-1" },
    },
  };

  render(createElement(ChatPage));

  expect(await screen.findByRole("heading", { name: privateChannel.name })).not.toBeNull();
  expect(await screen.findByText("初始连接期间的 Agent 回复")).not.toBeNull();
});

it("uploads attachments as the original File stream and lists owner and Agent files with downloads", async () => {
  attachments = [
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
  expect(attachmentUploads).toHaveLength(1);
  expect(attachmentUploads[0]?.body).toBe(file);
  expect(attachmentUploads[0]?.headers.get("content-type")).toBe("text/plain");
  expect(attachmentUploads[0]?.headers.get("x-mate-filename")).toBe(
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
  failNextAttachmentUpload = true;
  await user.click(screen.getByRole("button", { name: "上传附件" }));

  expect(await screen.findByRole("alert")).not.toBeNull();
  expect(screen.getByRole("alert").textContent).toContain("附件超过文件大小上限");
  expect((screen.getByLabelText("添加附件") as HTMLInputElement).files?.[0]).toBe(file);
  await user.click(screen.getByRole("button", { name: "上传附件" }));
  expect(await screen.findByText("notes.txt")).not.toBeNull();
  expect(attachmentUploads).toHaveLength(2);
  expect(attachmentUploads[1]?.body).toBe(file);
});

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

  await waitFor(() => expect(posts).toEqual([{ channelId: privateChannel.id, text: "私有草稿" }]));
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
  expect(posts).toEqual([{ channelId: publicChannel.id, text: "提交 A" }]);
  expect(
    (screen.getByRole("textbox", { name: "发送到 公开频道" }) as HTMLTextAreaElement).value,
  ).toBe("提交 A期间输入 B");
});

it("loads history only for the selected channel and drops inactive live messages", async () => {
  const user = await openChat();
  const stream = TestEventSource.instances[0]!;

  act(() => {
    stream.emit("message.created", {
      seq: 1,
      kind: "message.created",
      channelId: privateChannel.id,
      payload: message(privateChannel.id, "inactive-live", "未选中频道的临时事件", "1"),
    });
  });
  await user.click(screen.getByRole("button", { name: /私有频道/ }));
  await screen.findByRole("heading", { name: "私有频道" });
  expect(screen.queryByText("未选中频道的临时事件")).toBeNull();

  act(() => {
    stream.emit("message.created", {
      seq: 2,
      kind: "message.created",
      channelId: privateChannel.id,
      payload: message(privateChannel.id, "active-live", "当前频道实时消息", "1"),
    });
  });
  expect(await screen.findByText("当前频道实时消息")).not.toBeNull();

  await user.click(screen.getByRole("button", { name: /公开频道/ }));
  await screen.findByRole("heading", { name: "公开频道" });
  expect(screen.queryByText("当前频道实时消息")).toBeNull();
});

it("bounds the loaded window while preserving older-page and return-to-latest navigation", async () => {
  history.set(
    publicChannel.id,
    Array.from({ length: 200 }, (_, index) =>
      message(publicChannel.id, `history-${index + 1}`, `历史消息 ${index + 1}`, String(index + 1)),
    ),
  );
  const user = await openChat();

  for (const firstOrder of [101, 51, 1]) {
    await user.click(await screen.findByRole("button", { name: "加载更早消息" }));
    expect(await screen.findByText(`历史消息 ${firstOrder}`)).not.toBeNull();
  }
  expect(document.querySelectorAll(".message-row")).toHaveLength(200);
  expect(screen.getByText("历史消息 1")).not.toBeNull();
  expect(screen.getByText("历史消息 200")).not.toBeNull();

  const liveMessages = Array.from({ length: 5 }, (_, index) => {
    const order = index + 201;
    return message(publicChannel.id, `live-${order}`, `实时消息 ${order}`, String(order));
  });
  history.set(publicChannel.id, [...(history.get(publicChannel.id) ?? []), ...liveMessages]);
  act(() => {
    liveMessages.forEach((payload, index) => {
      TestEventSource.instances[0]!.emit("message.created", {
        seq: index + 1,
        kind: "message.created",
        channelId: publicChannel.id,
        payload,
      });
    });
  });

  await waitFor(() => expect(document.querySelectorAll(".message-row")).toHaveLength(200));
  expect(screen.queryByText("历史消息 1")).toBeNull();
  expect(screen.getByText("历史消息 6")).not.toBeNull();
  expect(screen.getByText("实时消息 205")).not.toBeNull();

  await user.click(await screen.findByRole("button", { name: "加载更早消息" }));
  expect(await screen.findByText("历史消息 1")).not.toBeNull();
  expect(screen.getByRole("button", { name: "返回最新消息" })).not.toBeNull();
  await user.click(screen.getByRole("button", { name: "返回最新消息" }));
  expect(await screen.findByText("历史消息 156")).not.toBeNull();
  expect(screen.getByText("实时消息 205")).not.toBeNull();
  expect(screen.queryByText("历史消息 1")).toBeNull();
  expect(document.querySelectorAll(".message-row")).toHaveLength(50);
});

it("keeps a return-to-latest path after sending from an older message window", async () => {
  history.set(
    publicChannel.id,
    Array.from({ length: 250 }, (_, index) =>
      message(publicChannel.id, `history-${index + 1}`, `历史消息 ${index + 1}`, String(index + 1)),
    ),
  );
  const user = await openChat();

  for (const firstOrder of [151, 101, 51, 1]) {
    await user.click(await screen.findByRole("button", { name: "加载更早消息" }));
    expect(await screen.findByText(`历史消息 ${firstOrder}`)).not.toBeNull();
  }
  expect(document.querySelectorAll(".message-row")).toHaveLength(200);
  expect(screen.getByText("历史消息 1")).not.toBeNull();
  expect(screen.getByText("历史消息 200")).not.toBeNull();
  expect(screen.queryByText("历史消息 201")).toBeNull();

  await user.type(screen.getByRole("textbox", { name: "发送到 公开频道" }), "新消息251");
  await user.click(screen.getByRole("button", { name: "发送" }));

  expect(await screen.findByText("新消息251")).not.toBeNull();
  expect(posts).toEqual([{ channelId: publicChannel.id, text: "新消息251" }]);
  expect(document.querySelectorAll(".message-row").length).toBeLessThanOrEqual(200);
  await user.click(screen.getByRole("button", { name: "返回最新消息" }));
  expect(await screen.findByText("历史消息 202")).not.toBeNull();
  expect(screen.getByText("新消息251")).not.toBeNull();
  expect(screen.queryByText("历史消息 1")).toBeNull();
  expect(document.querySelectorAll(".message-row")).toHaveLength(50);
});

it("ignores a failed latest-page request after switching to another channel", async () => {
  history.set(
    publicChannel.id,
    Array.from({ length: 250 }, (_, index) =>
      message(publicChannel.id, `history-${index + 1}`, `A 消息 ${index + 1}`, String(index + 1)),
    ),
  );
  history.set(privateChannel.id, [message(privateChannel.id, "private-1", "B 的消息", "1")]);
  const user = await openChat();

  for (const firstOrder of [151, 101, 51, 1]) {
    await user.click(await screen.findByRole("button", { name: "加载更早消息" }));
    expect(await screen.findByText(`A 消息 ${firstOrder}`)).not.toBeNull();
  }
  const gate = failNextLatestHistoryRequest(publicChannel.id);
  await user.click(screen.getByRole("button", { name: "返回最新消息" }));
  await gate.started;
  expect(screen.getByRole("button", { name: /正在读取最新消息/ })).not.toBeNull();

  await user.click(screen.getByRole("button", { name: /私有频道/ }));
  expect(await screen.findByText("B 的消息")).not.toBeNull();
  expect(screen.queryByRole("button", { name: /正在读取最新消息/ })).toBeNull();
  await act(async () => {
    gate.fail();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(screen.getByText("B 的消息")).not.toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(document.querySelectorAll(".message-row")).toHaveLength(1);
});

it("clears private chat and requests login when session revalidation gets 401", async () => {
  const user = await openChat();
  await user.click(screen.getByRole("button", { name: /私有频道/ }));
  await screen.findByRole("heading", { name: "私有频道" });
  expect(screen.getByText("私人记录")).not.toBeNull();
  sessionStatus = 401;

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

it("offers keyboard and touch reply actions, with the thread in a separate pane", async () => {
  const root = {
    ...message(publicChannel.id, "root-1", "根消息", "1"),
    replyCount: 1,
    recentReplies: [{ ...message(publicChannel.id, "reply-1", "已有讨论", "2"), rootId: "root-1" }],
  };
  history.set(publicChannel.id, [root, ...root.recentReplies]);
  const user = await openChat();
  const menu = await screen.findByRole("button", { name: "消息 根消息 的操作" });
  menu.focus();
  await user.keyboard("{Enter}");
  await user.click(screen.getByRole("button", { name: "普通回复（引用）" }));
  await user.type(screen.getByRole("textbox", { name: "发送到 公开频道" }), "主时间线答复");
  await user.click(screen.getByRole("button", { name: "发送" }));
  expect(positionPosts.at(-1)).toEqual({ quoteId: root.id });
  await user.click(menu);
  await user.click(screen.getByRole("button", { name: "讨论串回复" }));
  expect(await screen.findByRole("complementary", { name: "讨论串" })).not.toBeNull();
  expect(await screen.findByText("已有讨论")).not.toBeNull();
  await user.click(screen.getByRole("button", { name: "消息 已有讨论 的操作" }));
  expect(screen.getByRole("button", { name: "普通回复（引用）" })).not.toBeNull();
  expect(screen.getByRole("button", { name: "讨论串回复" })).not.toBeNull();
  await user.click(screen.getByRole("button", { name: "普通回复（引用）" }));
  await user.type(screen.getByRole("textbox", { name: "发送到 公开频道" }), "引用讨论回复");
  await user.click(screen.getByRole("button", { name: "发送" }));
  expect(positionPosts.at(-1)).toEqual({ quoteId: "reply-1" });
  await user.click(screen.getByRole("button", { name: "消息 已有讨论 的操作" }));
  await user.click(screen.getByRole("button", { name: "讨论串回复" }));
  await user.type(screen.getByRole("textbox", { name: "发送到 公开频道" }), "新讨论回复");
  await user.click(screen.getByRole("button", { name: "发送" }));
  expect(positionPosts.at(-1)).toEqual({ rootId: root.id });
  expect(await screen.findByText("新讨论回复")).not.toBeNull();
});

it("does not count an already loaded thread reply again when its event is replayed", async () => {
  const reply = {
    ...message(publicChannel.id, "reply-existing", "已载入的回复", "2"),
    rootId: "root-replay",
  };
  const root = {
    ...message(publicChannel.id, "root-replay", "重复事件根消息", "1"),
    replyCount: 1,
    recentReplies: [reply],
  };
  history.set(publicChannel.id, [root, reply]);
  await openChat();
  act(() =>
    TestEventSource.instances[0]!.emit("message.created", {
      seq: 1,
      kind: "message.created",
      channelId: publicChannel.id,
      payload: reply,
    }),
  );
  expect(screen.getByRole("button", { name: /1 条讨论串回复/ })).not.toBeNull();
});

it("ignores a delayed thread response after switching channels", async () => {
  const root = message(publicChannel.id, "slow-root", "慢讨论根消息", "1");
  history.set(publicChannel.id, [root]);
  let signalStarted!: () => void, release!: (value: Response) => void;
  const started = new Promise<void>((resolve) => (signalStarted = resolve));
  const response = new Promise<Response>((resolve) => (release = resolve));
  nextThreadGate = { rootId: root.id, started, signalStarted, response };
  const user = await openChat();
  await user.click(await screen.findByRole("button", { name: "消息 慢讨论根消息 的操作" }));
  await user.click(screen.getByRole("button", { name: "查看讨论串" }));
  await started;
  await user.click(screen.getByRole("button", { name: /私有频道/ }));
  await act(async () => {
    release(json(200, { root, replies: [] }));
  });
  await waitFor(() => expect(screen.queryByRole("complementary", { name: "讨论串" })).toBeNull());
});

it("keeps the newer thread when an earlier thread request completes last", async () => {
  const first = message(publicChannel.id, "first-root", "第一条根消息", "1");
  const second = message(publicChannel.id, "second-root", "第二条根消息", "2");
  history.set(publicChannel.id, [first, second]);
  let signalStarted!: () => void, release!: (value: Response) => void;
  const started = new Promise<void>((resolve) => (signalStarted = resolve));
  const response = new Promise<Response>((resolve) => (release = resolve));
  nextThreadGate = { rootId: first.id, started, signalStarted, response };
  const user = await openChat();
  await user.click(await screen.findByRole("button", { name: "消息 第一条根消息 的操作" }));
  await user.click(screen.getByRole("button", { name: "查看讨论串" }));
  await started;
  await user.click(screen.getByRole("button", { name: "消息 第二条根消息 的操作" }));
  await user.click(screen.getByRole("button", { name: "查看讨论串" }));
  expect(await screen.findByRole("complementary", { name: "讨论串" })).not.toBeNull();
  await act(async () => {
    release(json(200, { root: first, replies: [] }));
  });
  expect(screen.getByRole("complementary", { name: "讨论串" }).textContent).toContain(
    "第二条根消息",
  );
});

it("offers task sending and creating from an existing message with a visible task card", async () => {
  const user = await openChat();
  await user.type(screen.getByRole("textbox", { name: "发送到 公开频道" }), "Prepare the release");
  await user.click(screen.getByRole("checkbox", { name: "作为任务发送" }));
  await user.click(screen.getByRole("button", { name: "发送", exact: true }));
  await waitFor(() => expect(taskPosts).toContainEqual({ asTask: true }));
  expect(await screen.findByText(/任务 · 待认领/)).not.toBeNull();
  await user.type(screen.getByRole("textbox", { name: "发送到 公开频道" }), "Follow up later");
  await user.click(screen.getByRole("button", { name: "发送", exact: true }));
  await user.click(screen.getByRole("button", { name: "消息 Follow up later 的操作" }));
  await user.click(screen.getByRole("button", { name: "从消息建任务" }));
  await waitFor(() => expect(taskPosts).toContainEqual({ messageId: "message-2" }));
  expect(screen.getAllByText(/任务 · 待认领/)).toHaveLength(2);
});
