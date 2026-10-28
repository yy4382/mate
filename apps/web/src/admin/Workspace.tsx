import { t, locale } from "../i18n.ts";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, File, Folder, House, Link2 } from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";
import type { WorkspaceListing } from "@mate/admin";
import { get } from "../shell/api.ts";
import { Button, ErrorLine, Notice } from "../shell/ui.tsx";

const join = (directory: string, name: string) =>
  directory === "." ? name : `${directory}/${name}`;
const parent = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".");

function formatBytes(size: number): string {
  if (size < 1024)
    return new Intl.NumberFormat(locale, {
      style: "unit",
      unit: "byte",
      unitDisplay: "short",
    }).format(size);
  const trim = (value: number) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);
  return size < 1024 * 1024 ? `${trim(size / 1024)} KB` : `${trim(size / 1024 / 1024)} MB`;
}

const list = "divide-y divide-border overflow-hidden rounded-lg border border-border";

function PathBar(props: { path: string; onOpen: (path: string) => void }) {
  const segments = props.path === "." ? [] : props.path.split("/");
  const crumb = "rounded-md px-1.5 py-0.5 hover:bg-border/50";
  return (
    <nav
      aria-label={t("Workspace.currentPath")}
      className="flex h-8 min-w-0 flex-1 items-center gap-1 overflow-x-auto rounded-md border border-border bg-subtle px-2 font-mono text-xs"
    >
      <button
        type="button"
        aria-label={t("Workspace.rootDirectory")}
        className={`${crumb} cursor-pointer text-muted [&_svg]:size-4`}
        onClick={() => props.onOpen(".")}
      >
        <House aria-hidden />
      </button>
      {segments.map((segment, index) => {
        const target = segments.slice(0, index + 1).join("/");
        return (
          <Fragment key={target}>
            <ChevronRight aria-hidden className="size-3.5 shrink-0 text-muted" />
            {index === segments.length - 1 ? (
              <span className="shrink-0 px-1.5">{segment}</span>
            ) : (
              <button
                type="button"
                className={`${crumb} shrink-0 cursor-pointer text-muted`}
                onClick={() => props.onOpen(target)}
              >
                {segment}
              </button>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}

function FileFrame(props: { path: string; size: number; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="flex items-center justify-between gap-3 border-b border-border bg-subtle px-4 py-2 text-sm">
        <span className="flex min-w-0 items-center gap-2 font-medium">
          <File aria-hidden className="size-4 shrink-0 text-muted" />
          <span className="truncate">{props.path.split("/").pop()}</span>
        </span>
        <span className="shrink-0 text-xs text-muted">{formatBytes(props.size)}</span>
      </div>
      {props.children}
    </div>
  );
}

const ENTRY_ICON = {
  directory: <Folder aria-hidden />,
  symlink: <Link2 aria-hidden />,
  file: <File aria-hidden />,
} as const;

/** Read-only browsing of an Agent's working directory, through its node. */
export function Workspace({ agentId }: { agentId: string }) {
  const [path, setPath] = useState(".");
  const listing = useQuery({
    queryKey: ["admin", "workspace", agentId, path],
    queryFn: () =>
      get<WorkspaceListing>(
        `/api/admin/agents/${agentId}/workspace?path=${encodeURIComponent(path)}`,
      ),
    retry: false,
    staleTime: 0,
  });
  const data = listing.data;
  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={path === "."} onClick={() => setPath(parent(path))}>
          {t("Workspace.parentDirectory")}
        </Button>
        <PathBar path={path} onOpen={setPath} />
      </div>
      <ErrorLine error={listing.error} />
      {listing.isFetching && data === undefined ? (
        <p className="text-sm text-muted">{t("Workspace.reading")}</p>
      ) : null}
      {data?.kind === "directory" ? (
        <>
          <ul className={list}>
            {data.entries.length === 0 ? (
              <li className="px-4 py-6 text-center text-sm text-muted">
                {t("Workspace.emptyDirectory")}
              </li>
            ) : null}
            {data.entries.map((entry) => (
              <li key={entry.name} className="flex items-center gap-3 hover:bg-subtle">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 py-2.5 pl-4 text-left text-sm [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted"
                  onClick={() => setPath(join(path, entry.name))}
                >
                  {ENTRY_ICON[entry.kind]}
                  <span className="truncate">{entry.name}</span>
                </button>
                {entry.kind === "file" ? (
                  <span className="shrink-0 pr-4 text-xs text-muted">
                    {formatBytes(entry.size)}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          {data.truncated ? (
            <Notice>{t("Workspace.thisDirectoryIsTooLargeOnlySomeEntries")}</Notice>
          ) : null}
        </>
      ) : null}
      {data?.kind === "file" ? (
        <>
          <FileFrame path={path} size={data.size}>
            <pre
              className="overflow-x-auto p-4 font-mono text-xs leading-5"
              data-testid="file-content"
            >
              {data.content}
            </pre>
          </FileFrame>
          {data.truncated ? (
            <Notice>{t("Workspace.thisFileIsTooLargeOnlyTheBeginning")}</Notice>
          ) : null}
        </>
      ) : null}
      {data?.kind === "binary" ? (
        <FileFrame path={path} size={data.size}>
          <p className="p-4 text-sm text-muted">{t("Workspace.binaryFileContentIsNotDisplayed")}</p>
        </FileFrame>
      ) : null}
    </div>
  );
}
