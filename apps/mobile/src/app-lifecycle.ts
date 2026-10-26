import type { AppState, AppStateStatus } from "react-native";
import type { MobileAuth } from "./auth";
import type { MobileNotifications } from "./notifications";

type LifecyclePlatform = {
  currentState: typeof AppState.currentState;
  subscribe(listener: (state: AppStateStatus) => void): () => void;
  focus(value: boolean): void;
};

export function startMobileLifecycle({
  auth,
  notifications,
  platform,
}: {
  auth: MobileAuth;
  notifications: MobileNotifications;
  platform: LifecyclePlatform;
}): () => void {
  let backgrounded = platform.currentState === "background";
  platform.focus(!backgrounded);
  const stop = platform.subscribe((state) => {
    if (state === "background") {
      backgrounded = true;
      platform.focus(false);
      void notifications.setSession(null);
    } else if (state === "active" && backgrounded) {
      backgrounded = false;
      void auth.revalidate();
      platform.focus(true);
    }
  });
  void auth.start();
  return stop;
}
