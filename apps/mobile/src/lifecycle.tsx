import { useEffect } from "react";
import { AppState } from "react-native";
import { focusManager } from "@tanstack/react-query";
import { auth } from "./auth-native";
import { notifications } from "./notifications-native";
import { startMobileLifecycle } from "./app-lifecycle";

export function AuthLifecycle() {
  useEffect(
    () =>
      startMobileLifecycle({
        auth,
        notifications,
        platform: {
          currentState: AppState.currentState,
          subscribe: (listener) => {
            const subscription = AppState.addEventListener("change", listener);
            return () => subscription.remove();
          },
          focus: (focused) => focusManager.setFocused(focused),
        },
      }),
    [],
  );
  return null;
}
