import { AccountAvatar } from "../shell/AccountAvatar.tsx";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, SearchX } from "lucide-react";
import { get } from "../shell/api.ts";
import { Link, navigate, useRoute } from "../shell/router.tsx";
import { EmptyState, ErrorLine, Input, PageHeader, timeLabel } from "../shell/ui.tsx";
import { accountName, useAccounts } from "./data.ts";
import type { Entry } from "./types.ts";

/** The body with every occurrence of the query marked, ignoring case. */
function Highlighted({ body, query }: { body: string; query: string }) {
  if (query === "") return <>{body}</>;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    <>
      {body.split(new RegExp(`(${escaped})`, "gi")).map((part, index) =>
        // The capture group puts every match at an odd index.
        index % 2 === 1 ? (
          <mark key={index} className="rounded-sm bg-accent-soft px-0.5 text-foreground">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

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
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 py-6 md:px-8 md:py-8">
      <div className="grid gap-4">
        <Link
          to="/app"
          className="inline-flex w-fit items-center gap-1.5 text-sm text-muted no-underline hover:text-foreground [&_svg]:size-4"
        >
          <ArrowLeft aria-hidden />
          返回聊天
        </Link>
        <PageHeader title={`搜索「${query}」`} description="在所有你能看到的会话里找消息。" />
        <form
          key={query}
          role="search"
          aria-label="搜索结果页搜索"
          onSubmit={(event) => {
            event.preventDefault();
            const next = String(new FormData(event.currentTarget).get("q") ?? "").trim();
            if (next !== "") navigate(`/app/search?q=${encodeURIComponent(next)}`);
          }}
        >
          <Input
            name="q"
            type="search"
            aria-label="搜索词"
            defaultValue={query}
            className="max-w-md"
          />
        </form>
      </div>
      <ErrorLine error={hits.error} />
      {hits.isPending && query !== "" ? <p className="text-sm text-muted">搜索中…</p> : null}
      {hits.data?.length === 0 ? (
        <EmptyState icon={<SearchX />} title="没有找到匹配的消息。">
          换个关键词试试。
        </EmptyState>
      ) : null}
      {hits.data === undefined || hits.data.length === 0 ? null : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
          {[...hits.data].reverse().map((hit) =>
            hit.kind === "message" ? (
              <li key={hit.messageId} className="grid gap-1.5 p-4">
                <div className="flex items-center gap-2 text-sm">
                  <AccountAvatar
                    accountId={hit.author}
                    name={accountName(accounts, hit.author)}
                    size="sm"
                  />
                  <strong className="font-medium">{accountName(accounts, hit.author)}</strong>
                  <time className="text-xs text-muted">{timeLabel(hit.at)}</time>
                </div>
                <p className="whitespace-pre-wrap break-words text-sm leading-6">
                  <Highlighted body={hit.body} query={query} />
                </p>
              </li>
            ) : null,
          )}
        </ul>
      )}
    </main>
  );
}
