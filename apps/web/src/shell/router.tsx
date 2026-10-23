import { useSyncExternalStore, type MouseEvent, type ReactNode } from "react";

/** Every page the client has, parsed from the address. Pages live under /app, and the login page at /login. */
export type Route =
  | { page: "login"; next: string | null }
  | {
      page: "chat";
      conversation: number | null;
      thread: number | null;
      seq: number | null;
      /** A handle whose direct message to open; the chat page redirects to that conversation. */
      dm: string | null;
    }
  | { page: "search"; query: string }
  | { page: "profile" }
  | { page: "admin"; section: "agents" | "providers" | "nodes" | "humans"; agentId: string | null }
  | { page: "none" };

const number = (text: string | undefined): number | null => {
  const value = Number(text);
  return text !== undefined && Number.isInteger(value) && value > 0 ? value : null;
};

export function parseRoute(pathname: string, search: string): Route {
  const query = new URLSearchParams(search);
  const parts = pathname.split("/").filter((part) => part !== "");
  if (parts[0] === "login") return { page: "login", next: query.get("next") };
  if (parts[0] !== "app") return { page: "none" };
  if (parts.length === 1)
    return { page: "chat", conversation: null, thread: null, seq: null, dm: query.get("dm") };
  if (parts[1] === "c") {
    const conversation = number(parts[2]);
    if (conversation === null) return { page: "none" };
    const thread = parts[3] === "t" ? number(parts[4]) : null;
    return {
      page: "chat",
      conversation,
      thread,
      seq: number(query.get("seq") ?? undefined),
      dm: null,
    };
  }
  if (parts[1] === "profile") return { page: "profile" };
  if (parts[1] === "search") return { page: "search", query: query.get("q") ?? "" };
  if (parts[1] === "admin") {
    const section = parts[2] ?? "agents";
    if (section === "providers" || section === "nodes" || section === "humans")
      return { page: "admin", section, agentId: null };
    if (section === "agents")
      return { page: "admin", section, agentId: parts[3] === undefined ? null : parts[3] };
  }
  return { page: "none" };
}

export const chatPath = (conversation: number, thread?: number | null, seq?: number | null) =>
  `/app/c/${conversation}${thread == null ? "" : `/t/${thread}`}${seq == null ? "" : `?seq=${seq}`}`;

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

const address = () => location.pathname + location.search;

export function navigate(path: string, options: { replace?: boolean } = {}): void {
  if (path === address()) return;
  if (options.replace) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
  for (const listener of listeners) listener();
}

export function useRoute(): Route {
  const current = useSyncExternalStore(subscribe, address);
  const [pathname = "", search = ""] = splitAddress(current);
  return parseRoute(pathname, search);
}

function splitAddress(value: string): [string, string] {
  const at = value.indexOf("?");
  return at < 0 ? [value, ""] : [value.slice(0, at), value.slice(at)];
}

export function Link(props: {
  to: string;
  className?: string;
  children: ReactNode;
  title?: string;
  "aria-label"?: string;
  "aria-current"?: "page" | undefined;
}) {
  const { to, children, ...rest } = props;
  const click = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} onClick={click} {...rest}>
      {children}
    </a>
  );
}
