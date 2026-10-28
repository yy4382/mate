import { randomUUID } from "expo-crypto";
import { fetch as streamFetch } from "expo/fetch";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { AppState } from "react-native";
import { focusManager } from "@tanstack/react-query";
import { auth } from "./auth-native";
import { MobileChat } from "./chat";
import { startMobileLifecycle } from "./lifecycle";
import { listenToNotifications, notifications } from "./notifications-native";

const ChatContext = createContext<MobileChat | null>(null);
/** Root provider: starts the app lifecycle and exposes the signed-in identity's chat. */
export function Session({ children }: { children: ReactNode }) {
  const [chat, setChat] = useState<MobileChat | null>(null);
  useEffect(() => {
    const stopNotifications = listenToNotifications();
    const stopLifecycle = startMobileLifecycle({
      auth,
      notifications,
      platform: {
        appState: AppState.currentState,
        subscribe: (listener) => {
          const subscription = AppState.addEventListener("change", listener);
          return () => subscription.remove();
        },
        focus: (foreground) => focusManager.setFocused(foreground),
        openChat: (server) =>
          new MobileChat(server, {
            fetch: (...args) => fetch(...args),
            stream: (...args) => streamFetch(...args),
            requestId: () => randomUUID(),
            expired: () => void auth.revalidate(),
          }),
        showChat: (chat) => setChat(chat),
      },
    });
    return () => {
      stopLifecycle();
      stopNotifications();
    };
  }, []);
  return <ChatContext.Provider value={chat}>{children}</ChatContext.Provider>;
}
export function useChat() {
  const chat = useContext(ChatContext);
  if (!chat) throw new Error("Chat requires a signed-in session");
  return chat;
}
export function useChatState() {
  const chat = useChat();
  return useSyncExternalStore(chat.subscribe, chat.getSnapshot);
}
export function useSessionChat() {
  return useContext(ChatContext);
}
