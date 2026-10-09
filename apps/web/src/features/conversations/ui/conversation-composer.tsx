import type { FormEvent, RefObject } from "react";
import type { Channel, Message } from "../conversation-responses.js";

export type ReplyTarget = { kind: "quote" | "thread"; message: Message };
type ConversationComposerProps = {
  selected: Channel;
  replyTarget: ReplyTarget | null;
  draft: string;
  asTask: boolean;
  busy: boolean;
  attachmentBusy: boolean;
  selectedFile: File | null;
  attachmentInputRef: RefObject<HTMLInputElement | null>;
  sendMessage: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onCancelReply: () => void;
  onDraftChange: (value: string) => void;
  onAsTaskChange: (value: boolean) => void;
  onFileChange: (file: File | null) => void;
  onUpload: () => Promise<void>;
};

export function ConversationComposer({
  selected,
  replyTarget,
  draft,
  asTask,
  busy,
  attachmentBusy,
  selectedFile,
  attachmentInputRef,
  sendMessage,
  onCancelReply,
  onDraftChange,
  onAsTaskChange,
  onFileChange,
  onUpload,
}: ConversationComposerProps) {
  return (
    <form className="message-composer" onSubmit={sendMessage}>
      {replyTarget && (
        <div className="reply-context">
          {replyTarget.kind === "quote" ? "普通回复，引用" : "讨论串回复"}：
          {replyTarget.message.text}
          <button type="button" onClick={() => onCancelReply()} aria-label="取消回复">
            ×
          </button>
        </div>
      )}
      <label className="visually-hidden" htmlFor="message-draft">
        发送到 {selected.name}
      </label>
      <textarea
        id="message-draft"
        rows={2}
        maxLength={20_000}
        placeholder={`发送消息到 ${selected.name}`}
        value={draft}
        onChange={(event) => {
          const value = event.currentTarget.value;
          onDraftChange(value);
        }}
      />
      <div className="composer-footer">
        <label>
          <input
            type="checkbox"
            checked={asTask}
            onChange={(event) => onAsTaskChange(event.currentTarget.checked)}
          />
          作为任务发送
        </label>
        <span>
          {replyTarget?.kind === "thread" ? "只显示在讨论串中" : "顶层消息会显示在频道时间线中"}
        </span>
        <div className="composer-actions">
          <label className="attachment-picker">
            添加附件
            <input
              ref={attachmentInputRef}
              aria-label="添加附件"
              type="file"
              disabled={busy || attachmentBusy}
              onChange={(event) => onFileChange(event.currentTarget.files?.[0] ?? null)}
            />
          </label>
          {selectedFile && <span className="selected-attachment">{selectedFile.name}</span>}
          <button
            type="button"
            onClick={() => void onUpload()}
            disabled={busy || attachmentBusy || !selectedFile}
          >
            {attachmentBusy ? "正在上传…" : "上传附件"}
          </button>
          <button type="submit" disabled={busy || !draft.trim()}>
            发送
          </button>
        </div>
      </div>
    </form>
  );
}
