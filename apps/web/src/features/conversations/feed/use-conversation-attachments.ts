import { useEffect, useRef, useState } from "react";
import {
  attachmentResponseSchema,
  attachmentsResponseSchema,
  type Attachment,
  type Channel,
} from "../conversation-responses.js";
import { ownerJSON } from "../owner-request.js";

/** Refresh the selected channel's attachment list every five seconds. */
const attachmentPollIntervalMs = 5_000;

export function useConversationAttachments(authenticated: boolean, selectedId: string | null) {
  const [attachmentsByChannel, setAttachmentsByChannel] = useState<Record<string, Attachment[]>>(
    {},
  );
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!authenticated || !selectedId) return;
    const channelId = selectedId;
    let active = true;
    setAttachmentError(null);
    setSelectedFile(null);
    if (attachmentInputRef.current) attachmentInputRef.current.value = "";
    async function refreshAttachments() {
      try {
        const result = await ownerJSON(
          `/api/owner/channels/${encodeURIComponent(channelId)}/attachments`,
          attachmentsResponseSchema,
        );
        if (active)
          setAttachmentsByChannel((current) => ({ ...current, [channelId]: result.attachments }));
      } catch (cause) {
        if (active)
          setAttachmentError(cause instanceof Error ? cause.message : "暂时无法读取频道附件。");
      }
    }
    void refreshAttachments();
    const interval = window.setInterval(() => void refreshAttachments(), attachmentPollIntervalMs);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [authenticated, selectedId]);

  async function uploadAttachment(selected: Channel | null) {
    if (!selected || selected.archived || !selectedFile || attachmentBusy) return;
    const channelId = selected.id,
      file = selectedFile;
    setAttachmentBusy(true);
    setAttachmentError(null);
    try {
      const result = await ownerJSON(
        `/api/owner/channels/${encodeURIComponent(channelId)}/attachments`,
        attachmentResponseSchema,
        {
          method: "POST",
          headers: {
            "Content-Type": file.type || "application/octet-stream",
            "X-Mate-Filename": encodeURIComponent(file.name),
          },
          body: file,
        },
      );
      setAttachmentsByChannel((current) => ({
        ...current,
        [channelId]: [...(current[channelId] ?? []), result.attachment],
      }));
      setSelectedFile(null);
      if (attachmentInputRef.current) attachmentInputRef.current.value = "";
    } catch (cause) {
      setAttachmentError(cause instanceof Error ? cause.message : "附件上传失败，请重试。");
    } finally {
      setAttachmentBusy(false);
    }
  }

  return {
    currentAttachments: selectedId ? (attachmentsByChannel[selectedId] ?? []) : [],
    attachmentError,
    attachmentBusy,
    selectedFile,
    setSelectedFile,
    attachmentInputRef,
    uploadAttachment,
  };
}
