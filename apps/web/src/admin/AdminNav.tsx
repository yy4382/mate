import { t } from "../i18n.ts";
import { Bot, KeyRound, Server, Users } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useRoute } from "../shell/router.tsx";
import { cx } from "../shell/ui.tsx";

type Section = "agents" | "providers" | "nodes" | "humans";

const sections: { section: Section; label: string; icon: ReactNode }[] = [
  { section: "agents", label: t("common.agents"), icon: <Bot aria-hidden /> },
  { section: "providers", label: t("AdminNav.providers"), icon: <KeyRound aria-hidden /> },
  { section: "nodes", label: t("common.nodes"), icon: <Server aria-hidden /> },
  { section: "humans", label: t("AdminNav.humans"), icon: <Users aria-hidden /> },
];

/** The admin section's links: a tab row above the page on phones, a list in the sidebar on desktop. */
export function AdminNav() {
  const route = useRoute();
  const current = route.page === "admin" ? route.section : null;
  return (
    <nav
      aria-label={t("AdminNav.administration")}
      className="flex gap-1 overflow-x-auto border-b border-border px-4 md:flex-1 md:flex-col md:gap-0.5 md:border-0 md:p-2"
    >
      {sections.map((item) => (
        <Link
          key={item.section}
          to={`/app/admin/${item.section}`}
          {...(item.section === current ? { "aria-current": "page" as const } : {})}
          className={cx(
            "-mb-px inline-flex h-9 shrink-0 items-center gap-2 border-b-2 border-transparent px-3 text-sm text-muted no-underline hover:text-foreground aria-[current=page]:border-foreground aria-[current=page]:text-foreground",
            "md:mb-0 md:h-9 md:border-0 md:px-2 md:text-foreground md:hover:bg-border/50 md:aria-[current=page]:bg-border/60 md:aria-[current=page]:font-medium",
            "[&_svg]:size-4 [&_svg]:shrink-0",
          )}
        >
          {item.icon}
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
