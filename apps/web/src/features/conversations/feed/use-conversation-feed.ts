import type { RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import { redirectToLogin } from "../../../navigation.js";
import {
  messageContextSchema,
  messagePageSchema,
  readChatEvent,
  snapshotSchema,
  type Channel,
  type Message,
} from "../conversation-responses.js";
import { ownerJSON } from "../owner-request.js";
import {
  appendToLatestWindow,
  emptyMessageWindow,
  mergeLoadedPage,
  prependOlderWindow,
  receiveMessage,
  replaceWithLatestPage,
  type MessageWindow,
} from "./message-window.js";
import type { useConversationThread } from "./use-conversation-thread.js";

const messageHistoryPageSize = 50;

export function useConversationFeed({
  authenticated,
  selectedId,
  selectedIdRef,
  onSelect,
  onSessionExpired,
  onMobileView,
  onError,
  thread,
}: {
  authenticated: boolean;
  selectedId: string | null;
  selectedIdRef: RefObject<string | null>;
  onSelect: (id: string | null) => void;
  onSessionExpired: () => void;
  onMobileView: (view: "chat" | "thread") => void;
  onError: (message: string | null) => void;
  thread: Pick<ReturnType<typeof useConversationThread>, "receiveStreamReply" | "install">;
}) {
  const { receiveStreamReply, install } = thread;
  const [channels, setChannels] = useState<Channel[]>([]);
  const [messageWindows, setMessageWindows] = useState<Record<string, MessageWindow>>({});
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadingLatestChannelId, setLoadingLatestChannelId] = useState<string | null>(null);
  const [deepLinkError, setDeepLinkError] = useState<string | null>(null);
  const [fallbackRefresh, setFallbackRefresh] = useState(0);
  const [live, setLive] = useState(false);
  const streamRef = useRef<EventSource | null>(null);
  const handledDeepLinkRef = useRef<string | null>(null);
  const failedDeepLinkRef = useRef<string | null>(null);
  const currentWindow = selectedId
    ? (messageWindows[selectedId] ?? emptyMessageWindow)
    : emptyMessageWindow;
  const loadingLatest = selectedId !== null && loadingLatestChannelId === selectedId;
  useEffect(() => {
    if (!authenticated) return;
    let active = true,
      checkingSession = false,
      expired = false;

    async function connectFromSnapshot() {
      try {
        const snapshot = await ownerJSON("/api/owner/snapshot", snapshotSchema);
        if (!active) return;
        setChannels(snapshot.channels);
        const current = selectedIdRef.current,
          requestedChannelId = new URLSearchParams(window.location.search).get("channel"),
          initialSelection =
            snapshot.channels.find((channel) => channel.id === current)?.id ??
            snapshot.channels.find((channel) => channel.id === requestedChannelId)?.id ??
            snapshot.channels.find((channel) => !channel.archived)?.id ??
            snapshot.channels[0]?.id ??
            null;
        // The stream can deliver a buffered first event before React commits this state update.
        selectedIdRef.current = initialSelection;
        onSelect(initialSelection);
        if (requestedChannelId && initialSelection === requestedChannelId) onMobileView("chat");
        streamRef.current?.close();
        const stream = new EventSource(`/api/owner/events?cursor=${snapshot.cursor}`);
        streamRef.current = stream;
        stream.onopen = () => setLive(true);
        const expireSession = () => {
          if (!active || expired) return;
          expired = true;
          stream.close();
          if (streamRef.current === stream) streamRef.current = null;
          onSessionExpired();
          setLive(false);
          setChannels([]);
          selectedIdRef.current = null;
          onSelect(null);
          setMessageWindows({});
          redirectToLogin();
        };
        stream.addEventListener("auth_required", expireSession);
        stream.onerror = () => {
          if (!active || expired) return;
          setLive(false);
          if (checkingSession) return;
          checkingSession = true;
          void fetch("/api/owner/session", { headers: { Accept: "application/json" } })
            .then((response) => {
              if (response.status === 401) expireSession();
            })
            .catch(() => undefined)
            .finally(() => {
              checkingSession = false;
            });
        };

        const applyChatEvent = (event: Event) => {
          if (!active || expired || streamRef.current !== stream) return;
          const update = readChatEvent(event);
          if (!update) return;
          if (update.kind !== "message.created") {
            setChannels((current) => {
              const found = current.some((channel) => channel.id === update.payload.id);
              return found
                ? current.map((channel) =>
                    channel.id === update.payload.id ? update.payload : channel,
                  )
                : [...current, update.payload];
            });
            return;
          }
          if (selectedIdRef.current !== update.channelId) return;
          if (update.payload.rootId) {
            receiveStreamReply(update.payload);
          }
          setMessageWindows((current) => ({
            [update.channelId]: receiveMessage(
              current[update.channelId] ?? emptyMessageWindow,
              update.payload,
            ),
          }));
        };
        stream.addEventListener("channel.created", applyChatEvent);
        stream.addEventListener("channel.updated", applyChatEvent);
        stream.addEventListener("message.created", applyChatEvent);
        stream.addEventListener("snapshot_required", () => {
          stream.close();
          setLive(false);
          setMessageWindows({});
          setHistoryRefresh((revision) => revision + 1);
          if (active) void connectFromSnapshot();
        });
      } catch (cause) {
        if (active) onError(cause instanceof Error ? cause.message : "无法读取频道。");
      }
    }

    void connectFromSnapshot();
    return () => {
      active = false;
      streamRef.current?.close();
      streamRef.current = null;
    };
  }, [authenticated, onSelect, onSessionExpired, onMobileView, onError, receiveStreamReply]);
  useEffect(() => {
    setDeepLinkError(null);
    setMessageWindows((current) =>
      selectedId && current[selectedId] ? { [selectedId]: current[selectedId] } : {},
    );
  }, [selectedId]);

  useEffect(() => {
    if (!authenticated || !selectedId) return;
    const deepLink = new URLSearchParams(window.location.search);
    const linkedMessage = deepLink.get("message");
    if (
      deepLink.get("channel") === selectedId &&
      linkedMessage &&
      handledDeepLinkRef.current !== `message-${linkedMessage}` &&
      failedDeepLinkRef.current !== `message-${linkedMessage}`
    )
      return;
    const channelId = selectedId;
    let active = true;
    setLoadingMessages(true);
    ownerJSON(`/api/owner/channels/${encodeURIComponent(channelId)}/messages`, messagePageSchema)
      .then((page) => {
        if (!active) return;
        setMessageWindows((current) => ({
          [channelId]: mergeLoadedPage(current[channelId] ?? emptyMessageWindow, page),
        }));
      })
      .catch((cause) => {
        if (active) onError(cause instanceof Error ? cause.message : "无法读取消息。");
      })
      .finally(() => {
        if (active) setLoadingMessages(false);
      });
    return () => {
      active = false;
    };
  }, [authenticated, selectedId, historyRefresh, fallbackRefresh]);

  useEffect(() => {
    if (!authenticated || !selectedId) return;
    const query = new URLSearchParams(window.location.search),
      channelId = query.get("channel"),
      messageId = query.get("message");
    if (!messageId || channelId !== selectedId) return;
    const targetId = `message-${messageId}`;
    if (handledDeepLinkRef.current === targetId || failedDeepLinkRef.current === targetId) return;
    let active = true;
    void ownerJSON(
      `/api/owner/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/context`,
      messageContextSchema,
    )
      .then((context) => {
        if (!active || selectedIdRef.current !== channelId) return;
        if (context.kind === "thread") {
          install(context.thread);
          onMobileView("thread");
          void ownerJSON(
            `/api/owner/channels/${encodeURIComponent(channelId)}/messages`,
            messagePageSchema,
          )
            .then((page) => {
              if (active && selectedIdRef.current === channelId)
                setMessageWindows({ [channelId]: { ...page, hasNewer: false } });
            })
            .catch(() => {});
        } else {
          setMessageWindows({
            [channelId]: { ...context.page, hasNewer: context.hasNewer },
          });
          onMobileView("chat");
        }
      })
      .catch((cause) => {
        if (!active || selectedIdRef.current !== channelId) return;
        if (cause instanceof Error && cause.message === "登录状态已失效") return;
        failedDeepLinkRef.current = targetId;
        setDeepLinkError("通知中的消息无法打开，已切换到频道最新消息。");
        onMobileView("chat");
        setFallbackRefresh((revision) => revision + 1);
      });
    return () => {
      active = false;
    };
  }, [authenticated, selectedId, onMobileView, onError, install]);
  async function loadOlder() {
    if (!selectedId || !currentWindow.nextBefore) return;
    const channelId = selectedId,
      cursor = currentWindow.nextBefore;
    setLoadingOlder(true);
    onError(null);
    try {
      const page = await ownerJSON(
        `/api/owner/channels/${encodeURIComponent(channelId)}/messages?before=${cursor}&limit=${messageHistoryPageSize}`,
        messagePageSchema,
      );
      if (selectedIdRef.current !== channelId) return;
      setMessageWindows((current) => ({
        [channelId]: prependOlderWindow(current[channelId] ?? emptyMessageWindow, page),
      }));
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "无法读取更早的消息。");
    } finally {
      setLoadingOlder(false);
    }
  }

  async function returnToLatest() {
    if (!selectedId) return;
    const channelId = selectedId;
    setLoadingLatestChannelId(channelId);
    onError(null);
    setMessageWindows((current) => {
      const window = current[channelId] ?? emptyMessageWindow;
      return { [channelId]: { ...window, hasNewer: false } };
    });
    try {
      const page = await ownerJSON(
        `/api/owner/channels/${encodeURIComponent(channelId)}/messages`,
        messagePageSchema,
      );
      if (selectedIdRef.current !== channelId) return;
      setMessageWindows((current) => ({
        [channelId]: replaceWithLatestPage(current[channelId] ?? emptyMessageWindow, page),
      }));
    } catch (cause) {
      if (selectedIdRef.current === channelId) {
        onError(cause instanceof Error ? cause.message : "无法读取最新消息。");
        setMessageWindows((current) => {
          const window = current[channelId] ?? emptyMessageWindow;
          return { [channelId]: { ...window, hasNewer: true } };
        });
      }
    } finally {
      setLoadingLatestChannelId((current) => (current === channelId ? null : current));
    }
  }
  function appendSubmittedMessage(channelId: string, message: Message) {
    if (selectedIdRef.current === channelId && !message.rootId)
      setMessageWindows((current) => ({
        [channelId]: appendToLatestWindow(current[channelId] ?? emptyMessageWindow, [message]),
      }));
  }
  function channelCreated(channel: Channel) {
    setChannels((current) =>
      current.some((entry) => entry.id === channel.id) ? current : [...current, channel],
    );
  }
  function channelUpdated(channel: Channel) {
    setChannels((current) => current.map((entry) => (entry.id === channel.id ? channel : entry)));
  }
  return {
    channels,
    currentWindow,
    messageWindows,
    loadingMessages,
    loadingOlder,
    loadingLatest,
    deepLinkError,
    live,
    handledDeepLinkRef,
    loadOlder,
    returnToLatest,
    appendSubmittedMessage,
    channelCreated,
    channelUpdated,
  };
}
