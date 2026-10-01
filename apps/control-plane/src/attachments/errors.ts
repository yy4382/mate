export class AttachmentError extends Error {
  constructor(
    readonly code:
      | "conversation_unavailable"
      | "attachment_not_found"
      | "invalid_filename"
      | "too_large"
      | "upload_failed"
      | "workspace_unavailable"
      | "operation_conflict"
      | "operation_unknown",
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 413 | 416 | 500 | 502 | 503,
  ) {
    super(message);
    this.name = "AttachmentError";
  }
}
