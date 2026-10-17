import { useQuery } from "@tanstack/react-query";
import { get } from "../shell/api.ts";
import { Link, useRoute } from "../shell/router.tsx";
import { ErrorLine, timeLabel } from "../shell/ui.tsx";
import { accountName, useAccounts } from "./data.ts";
import type { Entry } from "./types.ts";

export function SearchPage() {
  const route = useRoute();
  const query = route.page === "search" ? route.query : "";
  const accounts = useAccounts().data ?? [];
  const hits = useQuery({
    queryKey: ["chat", "search", query],
    queryFn: () => get<Entry[]>(`/api/chat/search?q=${encodeURIComponent(query)}`),
    enabled: query !== "",
    staleTime: 0,
    retry: false,
  });
  return (
    <main className="page">
      <h1>搜索「{query}」</h1>
      <Link to="/app">返回聊天</Link>
      <ErrorLine error={hits.error} />
      {hits.isPending && query !== "" ? <p className="splash">搜索中…</p> : null}
      {hits.data?.length === 0 ? <p className="empty">没有找到匹配的消息。</p> : null}
      <ul className="hits">
        {[...(hits.data ?? [])].reverse().map((hit) =>
          hit.kind === "message" ? (
            <li key={hit.messageId} className="hit">
              <header>
                <strong>{accountName(accounts, hit.author)}</strong>
                <time>{timeLabel(hit.at)}</time>
              </header>
              <p className="body">{hit.body}</p>
            </li>
          ) : null,
        )}
      </ul>
    </main>
  );
}
