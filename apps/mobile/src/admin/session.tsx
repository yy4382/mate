import { t } from "../i18n";
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
import { Keyboard } from "react-native";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { useFocusEffect, useNavigation } from "expo-router";
import { fetch as streamingFetch } from "expo/fetch";
import { auth } from "../auth-native";
import { ManagementClient } from "./client";
import { Creation, newAgentDraft } from "./creation";
import { PresentationAccess } from "../ui";

const Client = createContext<ManagementClient | null>(null);

function Session({ client, children }: { client: ManagementClient; children: ReactNode }) {
  const { kind } = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [queries] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } }),
  );
  const creation = useState(newAgentDraft);
  useEffect(() => {
    if (kind !== "ready") {
      Keyboard.dismiss();
      void queries.cancelQueries();
      if (kind === "closed") queries.clear();
    } else void queries.invalidateQueries();
  }, [kind, queries]);
  useEffect(
    () => () => {
      void queries.cancelQueries();
      queries.clear();
    },
    [queries],
  );
  if (kind === "closed") return null;
  return (
    <Client.Provider value={client}>
      <PresentationAccess.Provider value={kind === "ready"}>
        <QueryClientProvider client={queries}>
          <Creation.Provider value={creation}>{children}</Creation.Provider>
        </QueryClientProvider>
      </PresentationAccess.Provider>
    </Client.Provider>
  );
}

export function ManagementScope({ children }: { children: ReactNode }) {
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
    <KeyboardProvider preload={false}>
      {scope && (
        <Session key={scope.id} client={scope.client}>
          {children}
        </Session>
      )}
    </KeyboardProvider>
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

/** Whether the calling screen may still navigate once an awaited operation settles. */
export function useCanNavigate() {
  const navigation = useNavigation();
  const client = useClient();
  return () => navigation.isFocused() && client.getSnapshot().kind === "ready";
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

const idle: { busy: boolean; error: unknown; message: string } = {
  busy: false,
  error: null,
  message: "",
};

export function useOperation() {
  const [outcome, setOutcome] = useState(idle);
  const busy = useRef(false);
  return {
    ...outcome,
    reset: () => {
      if (!busy.current) setOutcome(idle);
    },
    run: async (work: () => Promise<unknown>, message = t("management.saved_2")) => {
      if (busy.current) return false;
      busy.current = true;
      setOutcome({ ...idle, busy: true });
      try {
        await work();
        setOutcome({ ...idle, message });
        return true;
      } catch (error) {
        setOutcome({ ...idle, error });
        return false;
      } finally {
        busy.current = false;
      }
    },
  };
}
