import type { z } from "zod";
import type { workspaceOperationSchema, WorkspaceOperation } from "@mate/protocol";
import type { OwnerMessage, ModelCredentialSummary } from "@mate/protocol/owner";
import type { WorkspaceDirectoryPage, WorkspaceVersion } from "@mate/protocol/workspace";

declare const message: OwnerMessage;
const reply: OwnerMessage = message.recentReplies[0]!;
const replyText: string = message.recentReplies[0]!.text;
const nestedReply: OwnerMessage = reply.recentReplies[0]!;

// These imports resolve the emitted public declarations, including the recursive reply schema.
// A naked inferred recursive getter can emit an erased `any` shape across a package boundary.
// @ts-expect-error Message text remains a string at every reply depth.
const wrongReplyText: number = nestedReply.text;

const listInput: z.input<typeof workspaceOperationSchema> = { kind: "workspace_list", path: "" };
// @ts-expect-error Parsed operations include the existing pagination defaults.
const missingListDefaults: WorkspaceOperation = { kind: "workspace_list", path: "" };
const listOutput: WorkspaceOperation = { ...listInput, offset: 0, limit: 32 };

declare const directory: WorkspaceDirectoryPage;
const nextOffset: number | null = directory.nextOffset;
declare const version: WorkspaceVersion;
const changedNs: string = version.changedNs;
const credential: ModelCredentialSummary = { provider: "service", configured: true, updatedAt: 0 };

void [
  replyText,
  wrongReplyText,
  missingListDefaults,
  listOutput,
  nextOffset,
  changedNs,
  credential,
];
