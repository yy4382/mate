import { useState, type ReactNode } from "react";
import { describe } from "./api.ts";

/** A button whose first click asks "sure?" and whose second click acts. Nothing irreversible happens on one click. */
export function ConfirmButton(props: {
  label: string;
  confirm?: string;
  danger?: boolean;
  disabled?: boolean;
  onConfirm: () => void;
}) {
  const [asking, setAsking] = useState(false);
  return asking ? (
    <span className="confirm">
      <button
        type="button"
        className="button danger"
        onClick={() => {
          setAsking(false);
          props.onConfirm();
        }}
      >
        {props.confirm ?? `确认${props.label}`}
      </button>
      <button type="button" className="button" onClick={() => setAsking(false)}>
        取消
      </button>
    </span>
  ) : (
    <button
      type="button"
      className={props.danger ? "button danger-outline" : "button"}
      disabled={props.disabled}
      onClick={() => setAsking(true)}
    >
      {props.label}
    </button>
  );
}

export function ErrorLine({ error }: { error: unknown }) {
  return error === null || error === undefined ? null : (
    <p className="error" role="alert">
      {describe(error)}
    </p>
  );
}

export function Dialog(props: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="dialog-backdrop" onMouseDown={props.onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-label={props.title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <h2>{props.title}</h2>
          <button type="button" className="icon-button" aria-label="关闭" onClick={props.onClose}>
            ×
          </button>
        </header>
        {props.children}
      </div>
    </div>
  );
}

export function timeLabel(at: number): string {
  const date = new Date(at);
  const today = new Date();
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  return date.toDateString() === today.toDateString()
    ? time
    : `${date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })} ${time}`;
}
