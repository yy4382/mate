import { mentionsIn, timelineKey, unsentText, type TimelineKey } from "@mate/chat/client";
import { useSyncExternalStore } from "react";
import { ApiError, describe, post } from "../shell/api.ts";
import type { AccountView, TimelineRef } from "./types.ts";

/** A message on its way. It keeps its requestId until it is sent, so a retry is the same request. */
type Pending = {
  requestId: string;
  body: string;
  mentions: number[];
  /** The composer text this send covers; once sent, exactly that much leaves the composer. */
  text: string;
  status: "sending" | "failed";
};

type Draft = { text: string; pending: Pending | null; error: string | null };

const EMPTY: Draft = { text: "", pending: null, error: null };

/** Drafts outlive the screens that show them: leaving a channel, or the page reloading its state, loses nothing. */
const drafts = new Map<TimelineKey, Draft>();
const listeners = new Set<() => void>();

function update(key: TimelineKey, change: (draft: Draft) => Draft): void {
  drafts.set(key, change(drafts.get(key) ?? EMPTY));
  for (const listener of listeners) listener();
}

export function useDraft(ref: TimelineRef): Draft {
  const key = timelineKey(ref);
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => drafts.get(key) ?? EMPTY,
  );
}

export const setDraftText = (ref: TimelineRef, text: string) =>
  update(timelineKey(ref), (draft) => ({ ...draft, text }));

/** The accounts a message's `@handle` words name: the only way a message mentions someone. */

async function deliver(ref: TimelineRef): Promise<void> {
  const key = timelineKey(ref);
  const pending = drafts.get(key)?.pending;
  if (pending === undefined || pending === null) return;
  update(key, (draft) => ({ ...draft, pending: { ...pending, status: "sending" }, error: null }));
  try {
    await post("/api/chat/messages", {
      timeline: ref,
      requestId: pending.requestId,
      body: pending.body,
      mentions: pending.mentions,
    });
    update(key, (draft) => ({
      text: unsentText(draft.text, pending.text),
      pending: null,
      error: null,
    }));
  } catch (error) {
    // A refusal changed nothing, so the next send is a new request. Anything else may have reached the server.
    const refused = error instanceof ApiError && error.status >= 400 && error.status < 500;
    update(key, (draft) => ({
      ...draft,
      pending: refused ? null : { ...pending, status: "failed" },
      error: describe(error),
    }));
  }
}

/** Send the draft, or send again the message that failed (the same request, so it cannot arrive twice). */
export function sendDraft(ref: TimelineRef, accounts: readonly AccountView[]): Promise<void> {
  const key = timelineKey(ref);
  const draft = drafts.get(key) ?? EMPTY;
  if (draft.pending?.status === "sending") return Promise.resolve();
  if (draft.pending === null) {
    const body = draft.text.trim();
    if (body === "") return Promise.resolve();
    update(key, (d) => ({
      ...d,
      pending: {
        requestId: crypto.randomUUID(),
        body,
        mentions: mentionsIn(body, accounts),
        text: d.text,
        status: "sending",
      },
    }));
  }
  return deliver(ref);
}

export const abandonPending = (ref: TimelineRef) =>
  update(timelineKey(ref), (draft) => ({ ...draft, pending: null, error: null }));
