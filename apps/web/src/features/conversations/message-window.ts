import type { Message, MessagePage } from "./conversation-responses.js";

export type MessageWindow = MessagePage & { hasNewer: boolean };

const maxLoadedMessages = 200;
export const emptyMessageWindow: MessageWindow = {
  messages: [],
  nextBefore: null,
  hasNewer: false,
};

export function mergeMessage(messages: Message[], incoming: Message): Message[] {
  if (messages.some((message) => message.id === incoming.id)) return messages;
  return [...messages, incoming].sort((left, right) => {
    const a = BigInt(left.order),
      b = BigInt(right.order);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

export function mergeMessages(messages: Message[], incoming: Message[]): Message[] {
  return incoming.reduce(mergeMessage, messages);
}

function cursorIncludingEvicted(messages: Message[]): string {
  return String(BigInt(messages.at(-1)!.order) + 1n);
}

export function appendToLatestWindow(window: MessageWindow, incoming: Message[]): MessageWindow {
  const merged = mergeMessages(window.messages, incoming),
    overflow = Math.max(0, merged.length - maxLoadedMessages),
    evicted = merged.slice(0, overflow);
  return {
    ...window,
    messages: overflow ? merged.slice(-maxLoadedMessages) : merged,
    nextBefore: evicted.length ? cursorIncludingEvicted(evicted) : window.nextBefore,
  };
}

export function prependOlderWindow(window: MessageWindow, page: MessagePage): MessageWindow {
  const merged = mergeMessages(window.messages, page.messages),
    overflow = Math.max(0, merged.length - maxLoadedMessages);
  return {
    messages: overflow ? merged.slice(0, maxLoadedMessages) : merged,
    nextBefore: page.nextBefore,
    hasNewer: window.hasNewer || overflow > 0,
  };
}

/** Merge the initial page without losing events received while it was loading. */
export function mergeLoadedPage(window: MessageWindow, page: MessagePage): MessageWindow {
  return appendToLatestWindow({ ...window, nextBefore: page.nextBefore }, page.messages);
}

/** Replace a historical window, retaining only live events newer than the returned page. */
export function replaceWithLatestPage(window: MessageWindow, page: MessagePage): MessageWindow {
  const newestLoadedOrder = page.messages.at(-1)?.order,
    liveAfterPage =
      newestLoadedOrder === undefined
        ? []
        : window.messages.filter((message) => BigInt(message.order) > BigInt(newestLoadedOrder));
  return appendToLatestWindow(
    { messages: page.messages, nextBefore: page.nextBefore, hasNewer: false },
    liveAfterPage,
  );
}

/** Replayed events must neither pull a historical window forward nor double-count replies. */
export function receiveMessage(window: MessageWindow, incoming: Message): MessageWindow {
  if (window.hasNewer) return window;
  if (!incoming.rootId) return appendToLatestWindow(window, [incoming]);
  return {
    ...window,
    messages: window.messages.map((message) => {
      if (message.id !== incoming.rootId) return message;
      const lastReply = message.recentReplies?.at(-1),
        alreadyIncluded =
          message.recentReplies?.some((reply) => reply.id === incoming.id) ||
          (lastReply && BigInt(incoming.order) <= BigInt(lastReply.order));
      return {
        ...message,
        replyCount: alreadyIncluded ? (message.replyCount ?? 0) : (message.replyCount ?? 0) + 1,
        recentReplies: alreadyIncluded
          ? (message.recentReplies ?? [])
          : [...(message.recentReplies ?? []), incoming].slice(-3),
      };
    }),
  };
}
