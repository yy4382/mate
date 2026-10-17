import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { AdminPage } from "../admin/AdminPage.tsx";
import { ChatPage } from "../chat/ChatPage.tsx";
import { ChatLive } from "../chat/live.tsx";
import { SearchPage } from "../chat/Search.tsx";
import { useUnread } from "../chat/data.ts";
import { post } from "./api.ts";
import { Login } from "./Login.tsx";
import { PushToggle } from "./Push.tsx";
import { Link, useRoute } from "./router.tsx";

function Rail() {
  const route = useRoute();
  const unread = useUnread().data;
  const admin = route.page === "admin";
  return (
    <nav className="rail" aria-label="主导航">
      <Link to="/app" className="mark" aria-label="Mate">
        M
      </Link>
      <Link to="/app" className={admin ? "rail-item" : "rail-item active"}>
        <span aria-hidden>💬</span>
        <span>聊天</span>
        {unread !== undefined && unread.total > 0 ? (
          <span className="badge" aria-label={`${unread.total} 条未读`}>
            {unread.total}
          </span>
        ) : null}
      </Link>
      <Link to="/app/admin/agents" className={admin ? "rail-item active" : "rail-item"}>
        <span aria-hidden>🧑‍💻</span>
        <span>管理</span>
      </Link>
      <div className="rail-spacer" />
      <PushToggle />
      <button
        type="button"
        className="rail-item"
        onClick={async () => {
          await post("/api/logout");
          location.assign("/login");
        }}
      >
        <span aria-hidden>⎋</span>
        <span>退出</span>
      </button>
    </nav>
  );
}

function Pages() {
  const route = useRoute();
  return (
    <div className="shell">
      <Rail />
      <div className="content">
        {route.page === "chat" ? <ChatPage /> : null}
        {route.page === "search" ? <SearchPage /> : null}
        {route.page === "admin" ? <AdminPage route={route} /> : null}
        {route.page === "none" ? (
          <main className="page">
            <h1>找不到这个页面</h1>
            <Link to="/app">回到聊天</Link>
          </main>
        ) : null}
      </div>
    </div>
  );
}

export function App() {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
      }),
  );
  const route = useRoute();
  if (route.page === "login") return <Login next={route.next} />;
  return (
    <QueryClientProvider client={client}>
      <ChatLive>
        <Pages />
      </ChatLive>
    </QueryClientProvider>
  );
}
