import { useEffect } from "react";
import { AppState } from "react-native";
import { auth } from "./auth-native";
import { listenToNotifications, notifications } from "./notifications-native";

export function NotificationIntegration() {
  useEffect(() => {
    const stop = listenToNotifications();
    const sync = () => {
      const state = auth.getSnapshot();
      void notifications.setSession(
        state.kind === "signed-in"
          ? {
              server: state.server,
              accountId: state.human.accountId,
            }
          : null,
      );
    };
    const unsubscribe = auth.subscribe(sync);
    let backgrounded = AppState.currentState === "background";
    const foreground = AppState.addEventListener("change", (value) => {
      if (value === "background") {
        backgrounded = true;
        void notifications.setSession(null);
      } else if (value === "active" && backgrounded) {
        backgrounded = false;
        void auth.revalidate();
      }
    });
    sync();
    void auth.start();
    return () => {
      stop();
      unsubscribe();
      foreground.remove();
    };
  }, []);
  return null;
}
