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
  author: { kind: "human"; id: "owner" };
  text: string;
  order: string;
  revision: string;
  createdAt: number;
}

class TestEventSource {
  static instances: TestEventSource[] = [];
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly listeners = new Map<string, Array<(event: Event) => void>>();
  closed = false;

  constructor(readonly url: string) {
    TestEventSource.instances.push(this);
    queueMicrotask(() => this.onopen?.(new Event("open")));
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
    const match = url.match(/^\/api\/owner\/channels\/([^/]+)\/messages/);
    if (match) {
      const channelId = decodeURIComponent(match[1]!);
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { text: string };
        const created = message(channelId, `message-${posts.length + 1}`, body.text, "1");
        posts.push({ channelId, text: body.text });
        history.set(channelId, [...(history.get(channelId) ?? []), created]);
        return json(201, created);
      }
      return json(200, { messages: history.get(channelId) ?? [], nextBefore: null });
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
  channels = [publicChannel, privateChannel];
  history = new Map([
    [publicChannel.id, []],
    [privateChannel.id, []],
  ]);
  sessionStatus = 200;
  posts = [];
  TestEventSource.instances = [];
  installFetch();
  vi.mocked(redirectToLogin).mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
