import { liveRetryDelay, timelineQuery } from "@mate/chat/client";
import { t } from "../i18n.ts";
import { useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { get, redirectToLogin } from "../shell/api.ts";
import { useRoute, type Route } from "../shell/router.tsx";
import { applyLive, keys, seed } from "./cache.ts";
import type { LiveEvents, LiveSnapshot, TimelineRef } from "./types.ts";

/** The timeline the address names, if any: it is loaded with the snapshot, before the stream starts. */
export function openTimeline(route: Route): TimelineRef | undefined {
  if (route.page !== "chat" || route.conversation === null) return undefined;
  return route.thread === null ? { conversation: route.conversation } : { thread: route.thread };
}

type Phase = "loading" | "ready";

/**
 * Keeps the chat view live. It loads a snapshot that already holds the timeline the address names, then follows the
 * snapshot's cursor on the event stream (the browser reconnects with `Last-Event-ID`, so a dropped connection resumes
 * where it stopped). `resnapshot` throws the cache away and starts again from a new snapshot; `login` leaves for the
 * login page. The children are shown once the first snapshot is in, and again after each reload of state.
 */
export function ChatLive({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const route = useRoute();
  const latest = useRef(route);
  latest.current = route;
  const [generation, setGeneration] = useState(0);
  const [phase, setPhase] = useState<Phase>("loading");

  useEffect(() => {
    let stopped = false;
    let source: EventSource | undefined;
    let failures = 0;

    const restart = () => {
      if (stopped) return;
      source?.close();
      qc.removeQueries({ queryKey: keys.all });
      setPhase("loading");
      setGeneration((value) => value + 1);
    };

    void (async () => {
      let snapshot: LiveSnapshot;
      for (;;) {
        try {
          const timeline = openTimeline(latest.current);
          snapshot = await get<LiveSnapshot>(
            `/api/chat/snapshot${timeline === undefined ? "" : `?${timelineQuery(timeline)}`}`,
          );
          break;
        } catch {
          // A timeline the address names may be gone; the snapshot without it still works.
          try {
            snapshot = await get<LiveSnapshot>("/api/chat/snapshot");
            break;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, liveRetryDelay(failures++)));
            if (stopped) return;
          }
        }
      }
      if (stopped) return;
      seed(qc, snapshot);
      setPhase("ready");
      source = new EventSource(`/api/chat/events?cursor=${encodeURIComponent(snapshot.cursor)}`);
      source.addEventListener("events", (message) => {
        const batch = JSON.parse((message as MessageEvent<string>).data) as LiveEvents;
        if (batch.status === "events") applyLive(qc, batch);
      });
      source.addEventListener("resnapshot", restart);
      source.addEventListener("login", () => redirectToLogin());
      source.addEventListener("error", () => {
        // The browser retries a dropped connection itself. A closed one was refused: find out why.
        if (source?.readyState !== EventSource.CLOSED) return;
        void get("/api/chat/unread").then(
          () => setTimeout(restart, liveRetryDelay(failures++)),
          () => setTimeout(restart, liveRetryDelay(Infinity)),
        );
      });
    })();

    return () => {
      stopped = true;
      source?.close();
    };
  }, [qc, generation]);

  if (phase === "loading") return <p className="splash">{t("live.loading")}</p>;
  return <Fragment key={generation}>{children}</Fragment>;
}
