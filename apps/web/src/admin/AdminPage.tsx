import { ShieldAlert } from "lucide-react";
import { useCurrentHuman } from "../shell/humans.ts";
import { Link, type Route } from "../shell/router.tsx";
import { EmptyState, buttonClass } from "../shell/ui.tsx";
import { AgentDetail } from "./AgentDetail.tsx";
import { Agents } from "./Agents.tsx";
import { Humans } from "./Humans.tsx";
import { Nodes } from "./Nodes.tsx";
import { Providers } from "./Providers.tsx";

export function AdminPage({ route }: { route: Extract<Route, { page: "admin" }> }) {
  const me = useCurrentHuman().data;
  if (me === undefined) return null;
  if (me.role !== "admin")
    return (
      <main className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 py-6 md:px-8 md:py-8">
        <EmptyState
          icon={<ShieldAlert />}
          title="需要管理员权限"
          action={
            <Link to="/app" className={buttonClass()}>
              回到聊天
            </Link>
          }
        >
          管理 Agent、提供商、node 和其他人类需要管理员。请联系管理员。
        </EmptyState>
      </main>
    );
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 py-6 md:px-8 md:py-8">
      {route.section === "agents" ? (
        route.agentId === null ? (
          <Agents />
        ) : (
          <AgentDetail agentId={route.agentId} />
        )
      ) : null}
      {route.section === "providers" ? <Providers /> : null}
      {route.section === "nodes" ? <Nodes /> : null}
      {route.section === "humans" ? <Humans /> : null}
    </main>
  );
}
