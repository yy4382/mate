import type { Route } from "../shell/router.tsx";
import { AgentDetail } from "./AgentDetail.tsx";
import { Agents } from "./Agents.tsx";
import { Nodes } from "./Nodes.tsx";
import { Providers } from "./Providers.tsx";

export function AdminPage({ route }: { route: Extract<Route, { page: "admin" }> }) {
  return (
    <main className="page admin">
      <h1>管理</h1>
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
