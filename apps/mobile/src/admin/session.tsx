import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { AppState } from "react-native";
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { Redirect, Stack, useFocusEffect } from "expo-router";
import { fetch as streamingFetch } from "expo/fetch";
import { auth } from "../auth-native";
import { ManagementClient, type SignedIn } from "./client";
import { Button, Screen, Copy, ErrorLine } from "./ui";
import { useTheme } from "../theme";

const Client = createContext<ManagementClient | null>(null);

function Session({ session, children }: { session: SignedIn; children: ReactNode }) {
  const [client] = useState(() => new ManagementClient(auth, session, fetch, streamingFetch));
  const [queries] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: 0 }, mutations: { retry: false } },
      }),
  );
  useEffect(
    () => () => {
      client.close();
      void queries.cancelQueries();
      queries.clear();
    },
    [client, queries],
  );
  return (
    <Client.Provider value={client}>
      <QueryClientProvider client={queries}>{children}</QueryClientProvider>
    </Client.Provider>
  );
}

export function ManagementLayout() {
  return (
    <KeyboardProvider preload={false}>
      <ManagementGate />
    </KeyboardProvider>
  );
}

function ManagementGate() {
  const colors = useTheme();
  const state = useSyncExternalStore(auth.subscribe, auth.getSnapshot);
  useEffect(() => {
    void auth.start();
    const listener = AppState.addEventListener("change", (next) => {
      focusManager.setFocused(next === "active");
      if (next === "active") void auth.revalidate();
    });
    return () => listener.remove();
  }, []);
  if (state.kind === "signed-in")
    return (
      <Session key={`${state.server}/${state.human.accountId}`} session={state}>
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: colors.background },
            headerTintColor: colors.foreground,
            contentStyle: { backgroundColor: colors.background },
            headerBackTitle: "返回",
          }}
        >
          <Stack.Screen name="admin" options={{ headerShown: false }} />
          <Stack.Screen name="profile" options={{ title: "个人资料" }} />
        </Stack>
      </Session>
    );
  if (state.kind === "unavailable")
    return (
      <Screen topInset>
        <ErrorLine error={state.message} />
        <Button title="重试连接" onPress={() => void auth.retry()} />
        <Button title="返回登录" onPress={() => void auth.logout()} />
      </Screen>
    );
  if (state.kind === "starting" || state.kind === "checking" || state.kind === "clearing")
    return (
      <Screen topInset>
        <Copy>正在验证登录…</Copy>
      </Screen>
    );
  return <Redirect href="/" />;
}

export function useClient(): ManagementClient {
  const client = useContext(Client);
  if (!client) throw new Error("Management routes require a signed-in session");
  return client;
}

export function useHuman() {
  const state = useSyncExternalStore(auth.subscribe, auth.getSnapshot);
  return state.kind === "signed-in" ? state.human : undefined;
}

export function useResource<T>(path: string, interval = 0) {
  const client = useClient();
  const queries = useQueryClient();
  const [focused, setFocused] = useState(false);
  const query = useQuery({
    queryKey: [path],
    queryFn: ({ signal }) => client.request<T>(path, "GET", undefined, signal),
    enabled: focused,
    refetchInterval: focused && interval ? interval : false,
  });
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      void queries.invalidateQueries({ queryKey: [path] });
      return () => setFocused(false);
    }, [queries, path]),
  );
  return {
    data: query.data,
    error: query.error,
    loading: query.isFetching || query.isPending,
    refresh: () => {
      void queries.invalidateQueries({ queryKey: [path] });
    },
  };
}

export function useOperation() {
  const mutation = useMutation({
    mutationFn: async ({ work, message }: { work: () => Promise<unknown>; message: string }) => {
      await work();
      return message;
    },
  });
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return {
    busy: mutation.isPending,
    error: mutation.error,
    message: mutation.isSuccess ? mutation.data : "",
    reset: () => {
      if (!busy.current) mutation.reset();
    },
    run: async (work: () => Promise<unknown>, message = "已保存。") => {
      if (busy.current) return false;
      busy.current = true;
      try {
        await mutation.mutateAsync({ work, message });
        return mounted.current;
      } catch {
        return false;
      } finally {
        busy.current = false;
      }
    },
  };
}
