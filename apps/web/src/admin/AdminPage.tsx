import type { Route } from "../shell/router.tsx";
import { Link } from "../shell/router.tsx";
import { AgentDetail } from "./AgentDetail.tsx";
import { Agents } from "./Agents.tsx";
import { Nodes } from "./Nodes.tsx";
import { Providers } from "./Providers.tsx";

export function AdminPage({ route }: { route: Extract<Route, { page: "admin" }> }) {
  const tab = (section: typeof route.section, label: string) => (
    <Link to={`/app/admin/${section}`} className={route.section === section ? "tab active" : "tab"}>
      {label}
    </Link>
  );
  return (
    <main className="page admin">
      <h1>管理</h1>
      <nav className="tabs" aria-label="管理">
        {tab("agents", "Agent")}
        {tab("providers", "提供商")}
        {tab("nodes", "Node")}
      </nav>
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
