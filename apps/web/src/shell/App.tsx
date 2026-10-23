import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Bell, BellOff, CircleUser, LogOut, MessageSquare, Settings2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { AdminNav } from "../admin/AdminNav.tsx";
import { AdminPage } from "../admin/AdminPage.tsx";
import { ChatPage } from "../chat/ChatPage.tsx";
import { ConversationList } from "../chat/ConversationList.tsx";
import { ChatLive } from "../chat/live.tsx";
import { SearchPage } from "../chat/Search.tsx";
import { useUnread } from "../chat/data.ts";
import { useCurrentHuman } from "./humans.ts";
import { Login } from "./Login.tsx";
import { usePush } from "./Push.tsx";
import { ProfilePage, logOut } from "./Profile.tsx";
import { Link, navigate, useRoute, type Route } from "./router.tsx";
import { Avatar, Badge, Menu, MenuItem, buttonClass, cx } from "./ui.tsx";

/** The brand mark, shared by the sidebar and the login page. */
export function Mark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cx(
        "grid size-6 shrink-0 place-items-center rounded-md bg-foreground text-xs font-semibold text-background",
        className,
      )}
    >
      M
    </span>
  );
}

/** How the section's own links show on a phone: as the whole screen, as a strip above the page, or not at all. */
type PhoneSlot = "screen" | "strip" | "hidden";

const phoneSlotClass: Record<PhoneSlot, string> = {
  screen: "col-span-full row-start-2 flex md:col-auto md:row-auto",
  strip: "col-span-full row-start-1 flex md:col-auto md:row-auto",
  hidden: "hidden md:flex",
};

/** What the sidebar shows under the main navigation for the current page. */
function sectionOf(route: Route, isAdmin: boolean): { slot: ReactNode; phone: PhoneSlot } {
  switch (route.page) {
    case "chat":
      return {
        slot: <ConversationList />,
        phone: route.conversation === null && route.dm === null ? "screen" : "hidden",
      };
    case "search":
      return { slot: <ConversationList />, phone: "hidden" };
    case "admin":
      return isAdmin ? { slot: <AdminNav />, phone: "strip" } : { slot: null, phone: "hidden" };
    default:
      return { slot: null, phone: "hidden" };
  }
}

const navItem =
  "relative flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-xs text-muted no-underline hover:text-foreground md:h-9 md:flex-none md:flex-row md:justify-start md:gap-2 md:rounded-md md:px-2 md:text-sm md:text-foreground md:hover:bg-border/50 aria-[current=page]:text-foreground md:aria-[current=page]:bg-border/60 md:aria-[current=page]:font-medium [&_svg]:size-5 md:[&_svg]:size-4 [&_svg]:shrink-0";

const bar =
  "box-content h-14 border-t border-border bg-background pb-[env(safe-area-inset-bottom)] md:box-border md:h-auto md:border-0 md:bg-transparent md:pb-0";

function MainNav() {
  const route = useRoute();
  const unread = useUnread().data;
  const isAdmin = useCurrentHuman().data?.role === "admin";
  const admin = route.page === "admin";
  return (
    <nav
      aria-label="主导航"
      className={cx(bar, "col-start-1 row-start-3 flex md:flex-col md:gap-0.5 md:p-2")}
    >
      <Link to="/app" aria-current={admin ? undefined : "page"} className={navItem}>
        <MessageSquare aria-hidden />
        聊天
        {unread !== undefined && unread.total > 0 ? (
          <Badge
            tone="accent"
            aria-label={`${unread.total} 条未读`}
            className="absolute left-1/2 top-1 ml-2 md:static md:ml-auto"
          >
            {unread.total}
          </Badge>
        ) : null}
      </Link>
      {isAdmin ? (
        <Link to="/app/admin/agents" aria-current={admin ? "page" : undefined} className={navItem}>
          <Settings2 aria-hidden />
          管理
        </Link>
      ) : null}
    </nav>
  );
}

function AccountMenu() {
  const push = usePush();
  const me = useCurrentHuman().data;
  const name = me?.displayName ?? "账号";
  return (
    <div className={cx(bar, "col-start-2 row-start-3 flex md:flex-col md:p-2")}>
      <Menu
        label={name}
        side="top"
        align="start"
        triggerClassName={cx(navItem, "cursor-pointer data-popup-open:text-foreground")}
        trigger={
          <>
            {me === undefined ? <CircleUser aria-hidden /> : <Avatar name={name} size="sm" />}
            <span className="max-w-full truncate">{name}</span>
            {push.problem === null ? null : (
              <span
                aria-hidden
                className="absolute right-1/4 top-2 size-2 rounded-full bg-danger md:hidden"
              />
            )}
          </>
        }
      >
        {push.problem === null ? null : (
          <MenuItem tone="danger" disabled>
            {push.problem}
          </MenuItem>
        )}
        {push.supported ? (
          <MenuItem
            icon={push.label === "关闭通知" ? <BellOff aria-hidden /> : <Bell aria-hidden />}
            disabled={push.disabled}
            onClick={push.toggle}
          >
            {push.label}
          </MenuItem>
        ) : null}
        <MenuItem icon={<CircleUser aria-hidden />} onClick={() => navigate("/app/profile")}>
          个人资料
        </MenuItem>
        <MenuItem icon={<LogOut aria-hidden />} onClick={() => void logOut()}>
          退出
        </MenuItem>
      </Menu>
      {push.problem === null ? null : (
        <p role="alert" className="break-words px-2 pt-1 text-xs text-danger max-md:hidden">
          {push.problem}
        </p>
      )}
    </div>
  );
}

function Pages() {
  const route = useRoute();
  const isAdmin = useCurrentHuman().data?.role === "admin";
  const { slot, phone } = sectionOf(route, isAdmin);
  return (
    <div className="grid h-dvh grid-cols-[minmax(0,2fr)_minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto] md:grid-cols-[15rem_minmax(0,1fr)] md:grid-rows-1">
      <div className="contents md:col-start-1 md:row-start-1 md:flex md:min-h-0 md:flex-col md:border-r md:border-border md:bg-subtle">
        <Link
          to="/app"
          className="hidden h-14 shrink-0 items-center gap-2 px-4 text-sm font-semibold text-foreground no-underline md:flex"
        >
          <Mark />
          Mate
        </Link>
        <MainNav />
        <div
          className={cx(
            "min-h-0 flex-col md:flex-1",
            slot !== null && "md:border-t md:border-border",
            phoneSlotClass[phone],
          )}
        >
          {slot}
        </div>
        <AccountMenu />
      </div>
      <div
        className={cx(
          "col-span-full row-start-2 min-h-0 min-w-0 overflow-auto md:col-span-1 md:col-start-2 md:row-start-1",
          phone === "screen" && "hidden md:block",
        )}
      >
        {route.page === "chat" ? <ChatPage /> : null}
        {route.page === "search" ? <SearchPage /> : null}
        {route.page === "admin" ? <AdminPage route={route} /> : null}
        {route.page === "profile" ? <ProfilePage /> : null}
        {route.page === "none" ? (
          <main className="mx-auto grid max-w-4xl gap-4 px-4 py-6 md:px-8 md:py-8">
            <h1 className="text-2xl font-semibold tracking-tight">找不到这个页面</h1>
            <Link to="/app" className={buttonClass({ className: "w-fit" })}>
              回到聊天
            </Link>
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
