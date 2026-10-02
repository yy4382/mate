import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Channel } from "./conversation-responses.js";

export type ChannelDraft = Pick<Channel, "name" | "description" | "visibility">;
export type ChannelSettings = ChannelDraft & Pick<Channel, "archived">;

interface ChannelDialogProps {
  kind: "create" | "settings";
  channel?: Channel | undefined;
  busy: boolean;
  onClose: () => void;
  onCreate: (channel: ChannelDraft) => void;
  onUpdate: (channel: ChannelSettings) => void;
}

export function ChannelDialog({
  kind,
  channel,
  busy,
  onClose,
  onCreate,
  onUpdate,
}: ChannelDialogProps) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const [name, setName] = useState(channel?.name ?? "");
  const [description, setDescription] = useState(channel?.description ?? "");
  const [visibility, setVisibility] = useState<Channel["visibility"]>(
    channel?.visibility ?? "public",
  );
  const [archived, setArchived] = useState(channel?.archived ?? false);

  useEffect(() => {
    const previouslyFocused =
        document.activeElement instanceof HTMLElement ? document.activeElement : null,
      dialog = dialogRef.current;
    if (!dialog) return;
    const modal = dialog;
    const focusable = () =>
      Array.from(
        modal.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hasAttribute("hidden"));
    (
      modal.querySelector<HTMLElement>("[data-initial-focus]") ??
      modal.querySelector<HTMLElement>("[autofocus]") ??
      focusable()[0] ??
      modal
    ).focus();

    function trapFocus(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable(),
        first = items[0],
        last = items.at(-1);
      if (!first || !last) {
        event.preventDefault();
        modal.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!modal.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", trapFocus);
    return () => {
      document.removeEventListener("keydown", trapFocus);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [onClose]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = { name, description, visibility };
    if (kind === "create") onCreate(input);
    else onUpdate({ ...input, archived });
  }

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        className="channel-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="channel-dialog-title"
        tabIndex={-1}
      >
        <div className="dialog-heading">
          <div>
            <p className="chat-eyebrow">频道管理</p>
            <h2 id="channel-dialog-title">{kind === "create" ? "新建频道" : "频道设置"}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <form className="channel-form" onSubmit={submit}>
          <label htmlFor="channel-name">频道名称</label>
          <input
            id="channel-name"
            data-initial-focus
            required
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
          />
          <label htmlFor="channel-description">简介</label>
          <textarea
            id="channel-description"
            rows={3}
            maxLength={500}
            value={description}
            onChange={(event) => setDescription(event.currentTarget.value)}
          />
          <fieldset>
            <legend>谁可以发现这个频道</legend>
            <label className="radio-row">
              <input
                type="radio"
                name="channel-visibility"
                value="public"
                checked={visibility === "public"}
                onChange={() => setVisibility("public")}
              />
              <span>
                <strong>公开</strong>
                <small>频道名称和简介可被发现。</small>
              </span>
            </label>
            <label className="radio-row">
              <input
                type="radio"
                name="channel-visibility"
                value="private"
                checked={visibility === "private"}
                onChange={() => setVisibility("private")}
              />
              <span>
                <strong>私有</strong>
                <small>只有所有者和已加入的成员可以看到。</small>
              </span>
            </label>
          </fieldset>
          {kind === "settings" && (
            <label className="archive-row">
              <input
                type="checkbox"
                checked={archived}
                onChange={(event) => setArchived(event.currentTarget.checked)}
              />
              <span>归档频道，停止发送新消息</span>
            </label>
          )}
          <div className="dialog-actions">
            <button className="secondary-button" type="button" onClick={onClose} disabled={busy}>
              取消
            </button>
            <button type="submit" disabled={busy || !name.trim()}>
              {busy ? "正在保存…" : kind === "create" ? "创建频道" : "保存更改"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
