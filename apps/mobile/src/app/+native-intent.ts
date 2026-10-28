export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    const url = new URL(path, "mate:///");
    if (url.protocol !== "mate:" && url.protocol !== "dev.yyang.mate:") return path;
    const pathname = url.hostname ? `/${url.hostname}${url.pathname}` : url.pathname;
    if (pathname !== "/agents" && !pathname.startsWith("/agents/")) return path;
    const target = pathname + url.search + url.hash;
    return `/admin/agents?target=${encodeURIComponent(target)}`;
  } catch {
    return path;
  }
}
