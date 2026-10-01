export class WorkspaceError extends Error {
  constructor(
    readonly code:
      | "agent_unavailable"
      | "node_offline"
      | "permission_denied"
      | "not_found"
      | "file_changed"
      | "unsafe_path"
      | "not_file"
      | "invalid_response"
      | "operation_unknown"
      | "operation_conflict"
      | "download_unknown"
      | "workspace_unavailable",
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 413 | 416 | 500 | 502 | 503,
    readonly lastConnectedAt?: string | null,
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}
