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
import { auth } from "./auth-native";
import { MobileChat } from "./chat";

const ChatContext = createContext<MobileChat | null>(null);
export function Session({ children }: { children: ReactNode }) {
  const [chat, setChat] = useState<MobileChat | null>(null);
  useEffect(() => {
    let current: MobileChat | null = null;
    let identity = "";
    const sync = () => {
      const state = auth.getSnapshot();
      if (state.kind === "signed-in") {
        const next = `${state.server}/${state.human.accountId}`;
        if (next !== identity) {
          current?.close();
          current = new MobileChat(state.server, {
            fetch: (...args) => fetch(...args),
            stream: (...args) => streamFetch(...args),
            requestId: () => randomUUID(),
            expired: () => void auth.revalidate(),
          });
          identity = next;
          setChat(current);
        }
        if (AppState.currentState === "active") void current?.resume();
        else current?.pause();
      } else if (state.kind === "checking" || state.kind === "unavailable") current?.pause();
      else {
        current?.close();
        current = null;
        identity = "";
        setChat(null);
      }
    };
    const unsubscribe = auth.subscribe(sync);
    const foreground = AppState.addEventListener("change", (value) => {
      if (value !== "active") current?.pause();
      else void auth.revalidate();
    });
    sync();
    void auth.start();
    return () => {
      unsubscribe();
      foreground.remove();
      current?.close();
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
