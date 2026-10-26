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
        state.kind === "signed-in" && AppState.currentState !== "background"
          ? {
              server: state.server,
              accountId: state.human.accountId,
            }
          : null,
      );
    };
    const unsubscribe = auth.subscribe(sync);
    sync();
    return () => {
      stop();
      unsubscribe();
    };
  }, []);
  return null;
}
