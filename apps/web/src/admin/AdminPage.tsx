import type { Route } from "../shell/router.tsx";
import { AgentDetail } from "./AgentDetail.tsx";
import { Agents } from "./Agents.tsx";
import { Nodes } from "./Nodes.tsx";
import { Providers } from "./Providers.tsx";

export function AdminPage({ route }: { route: Extract<Route, { page: "admin" }> }) {
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
    </main>
  );
}
