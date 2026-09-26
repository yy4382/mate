export function redirectToLogin(): void {
  const next = `${window.location.pathname}${window.location.search}`;
  window.location.replace(`/login?next=${encodeURIComponent(next)}`);
}

export function appReturnPath(search: string): string {
  const next = new URLSearchParams(search).get("next");
  if (!next || !/^\/app(?:[/?]|$)/.test(next) || next.includes("\\")) return "/app";
  return next;
}
