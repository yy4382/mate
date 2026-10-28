import type { AppState, AppStateStatus } from "react-native";
import type { MobileAuth } from "./auth";
import type { MobileNotifications } from "./notifications";

type Chat = { pause(): void; resume(): Promise<void>; close(): void };

/**
 * The only auth subscription and app-state listener: a signed-in session is available only in the
 * foreground, and only availability changes pause or resume notifications and the chat stream.
 */
export function startMobileLifecycle<C extends Chat>({
  auth,
  notifications,
  platform,
}: {
  auth: MobileAuth;
  notifications: MobileNotifications;
  platform: {
    appState: typeof AppState.currentState;
    subscribe(listener: (state: AppStateStatus) => void): () => void;
    focus(foreground: boolean): void;
    openChat(server: string): C;
    showChat(chat: C | null): void;
  };
}): () => void {
  let backgrounded = platform.appState === "background";
  let current: { identity: string; chat: C; running: boolean | null } | null = null;
  const sync = () => {
    const state = auth.getSnapshot();
    const available = state.kind === "signed-in" && !backgrounded;
    void notifications.setSession(
      available ? { server: state.server, accountId: state.human.accountId } : null,
    );
    if (state.kind === "signed-in") {
      const identity = `${state.server}/${state.human.accountId}`;
      if (current?.identity !== identity) {
        current?.chat.close();
        current = { identity, chat: platform.openChat(state.server), running: null };
        platform.showChat(current.chat);
      }
    } else if (current && state.kind !== "checking" && state.kind !== "unavailable") {
      current.chat.close();
      current = null;
      platform.showChat(null);
    }
    if (current && current.running !== available) {
      current.running = available;
      if (available) void current.chat.resume();
      else current.chat.pause();
    }
  };
  platform.focus(!backgrounded);
  const stopAppState = platform.subscribe((next) => {
    if (next === "background" && !backgrounded) backgrounded = true;
    else if (next === "active" && backgrounded) {
      backgrounded = false;
      // Publishes "checking" first, so nothing resumes before the cookie is verified again.
      void auth.revalidate();
    } else return;
    platform.focus(!backgrounded);
    sync();
  });
  const unsubscribe = auth.subscribe(sync);
  sync();
  void auth.start();
  return () => {
    stopAppState();
    unsubscribe();
    current?.chat.close();
  };
}
