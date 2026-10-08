import { useCallback, useRef, useState, type RefObject } from "react";
import type { z } from "zod";
import { threadSchema, type Message } from "../conversation-responses.js";
import { ownerJSON } from "../owner-request.js";
import { mergeMessage, mergeMessages } from "./message-window.js";

export function useConversationThread({
  selectedIdRef,
  onError,
}: {
  selectedIdRef: RefObject<string | null>;
  onError: (message: string) => void;
}) {
  const [threadRoot, setThreadRoot] = useState<Message | null>(null);
  const [threadReplies, setThreadReplies] = useState<Message[]>([]);
  const threadRootIdRef = useRef<string | null>(null);
  const threadRequestRef = useRef(0);
  threadRootIdRef.current = threadRoot?.id ?? null;

  const open = useCallback(
    async (message: Message) => {
      const request = ++threadRequestRef.current;
      threadRootIdRef.current = message.id;
      setThreadRoot(message);
      setThreadReplies([]);
      try {
        const thread = await ownerJSON(
          `/api/owner/channels/${encodeURIComponent(message.channelId)}/threads/${encodeURIComponent(message.id)}`,
          threadSchema,
        );
        if (threadRequestRef.current !== request || selectedIdRef.current !== message.channelId)
          return;
        setThreadRoot(thread.root);
        setThreadReplies((current) => mergeMessages(thread.replies, current));
      } catch (cause) {
        if (threadRequestRef.current === request)
          onError(cause instanceof Error ? cause.message : "无法读取讨论串。");
      }
    },
    [selectedIdRef, onError],
  );

  const close = useCallback(() => {
    ++threadRequestRef.current;
    threadRootIdRef.current = null;
    setThreadRoot(null);
  }, []);
  const reset = useCallback(() => {
    close();
    setThreadReplies([]);
  }, [close]);
  const installThread = useCallback((thread: z.infer<typeof threadSchema>) => {
    threadRootIdRef.current = thread.root.id;
    setThreadRoot(thread.root);
    setThreadReplies(thread.replies);
  }, []);
  const receiveStreamReply = useCallback((message: Message) => {
    setThreadReplies((current) =>
      threadRootIdRef.current === message.rootId ? mergeMessage(current, message) : current,
    );
  }, []);
  const appendSubmittedReply = useCallback((message: Message) => {
    setThreadReplies((current) => mergeMessage(current, message));
  }, []);

  return {
    threadRoot,
    threadReplies,
    open,
    close,
    reset,
    installThread,
    receiveStreamReply,
    appendSubmittedReply,
  };
}
