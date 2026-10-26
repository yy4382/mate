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
import { Keyboard, StyleSheet, View } from "react-native";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { Redirect, Stack, useFocusEffect } from "expo-router";
import { fetch as streamingFetch } from "expo/fetch";
import { auth } from "../auth-native";
import { ManagementClient } from "./client";
import { Button, Screen, Copy, ErrorLine, ManagementPresentationAccess } from "./ui";
import { useTheme } from "../theme";

const Client = createContext<ManagementClient | null>(null);

function Session({ client, children }: { client: ManagementClient; children: ReactNode }) {
  const access = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [queries] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: 0 }, mutations: { retry: false } },
      }),
  );
  useEffect(() => {
    if (access.kind !== "ready") {
      Keyboard.dismiss();
      void queries.cancelQueries();
      if (access.kind === "closed") queries.clear();
    } else void queries.invalidateQueries();
  }, [access, queries]);
  useEffect(
    () => () => {
      void queries.cancelQueries();
      queries.clear();
    },
    [queries],
  );
  if (access.kind === "closed") return null;
  const suspended = access.kind === "suspended";
  return (
    <View
      style={{ flex: 1, opacity: suspended ? 0 : 1 }}
      pointerEvents={suspended ? "none" : "auto"}
      accessibilityElementsHidden={suspended}
      importantForAccessibility={suspended ? "no-hide-descendants" : "auto"}
    >
      <Client.Provider value={client}>
        <ManagementPresentationAccess.Provider value={!suspended}>
          <QueryClientProvider client={queries}>{children}</QueryClientProvider>
        </ManagementPresentationAccess.Provider>
      </Client.Provider>
    </View>
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
  const [scope, setScope] = useState<{ client: ManagementClient; id: number } | null>(null);
  useEffect(() => {
    if (state.kind === "signed-in" && (!scope || scope.client.getSnapshot().kind === "closed"))
      setScope({
        client: new ManagementClient(auth, state, fetch, streamingFetch),
        id: (scope?.id ?? 0) + 1,
      });
  }, [state, scope]);
  useEffect(() => () => scope?.client.close(), [scope]);
  return (
    <View style={{ flex: 1 }}>
      {scope && (
        <Session key={scope.id} client={scope.client}>
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
      )}
      {state.kind !== "signed-in" && (
        <View style={StyleSheet.absoluteFill}>
          {state.kind === "unavailable" ? (
            <Screen topInset>
              <ErrorLine error={state.message} />
              <Button title="重试连接" onPress={() => void auth.retry()} />
              <Button title="返回登录" onPress={() => void auth.logout()} />
            </Screen>
          ) : state.kind === "starting" ||
            state.kind === "checking" ||
            state.kind === "clearing" ? (
            <Screen topInset>
              <Copy>正在验证登录…</Copy>
            </Screen>
          ) : (
            <Redirect href="/" />
          )}
        </View>
      )}
    </View>
  );
}

export function useClient(): ManagementClient {
  const client = useContext(Client);
  if (!client) throw new Error("Management routes require a signed-in session");
  return client;
}

export function useManagementAccess() {
  const client = useClient();
  return useSyncExternalStore(client.subscribe, client.getSnapshot);
}

export function useHuman() {
  const client = useClient();
  const access = useSyncExternalStore(client.subscribe, client.getSnapshot);
  return access.kind === "closed" ? undefined : access.session.human;
}

export function useResource<T>(path: string, interval = 0) {
  const client = useClient();
  const queries = useQueryClient();
  const ready = useManagementAccess().kind === "ready";
  const [focused, setFocused] = useState(false);
  const query = useQuery({
    queryKey: [path],
    queryFn: ({ signal }) => client.request<T>(path, "GET", undefined, signal),
    enabled: focused && ready,
    refetchInterval: focused && ready && interval ? interval : false,
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
