import type { RunToken } from "../storage/store.js";
import type { ConversationTarget as Target } from "../domain/conversations.js";
import type { Principal } from "../domain/messages.js";

export interface Space {
  conversationId: string;
  name?: string | undefined;
  purpose?: string | undefined;
  principal?: Principal | undefined;
  archived: boolean;
  kind: "channel" | "dm";
}
export interface SpacesResult {
  spaces: Space[];
  incomplete: boolean;
  retry?: string;
}
export interface MembersResult {
  members: Principal[];
  incomplete: boolean;
}
export type OpenDMResult = Target | { status: "failed"; receipt: unknown };
/** Application-owned port. Provider adapters translate external identifiers. */
export interface ConversationDirectory {
  capabilities?(actor: string, conversationId?: string): DirectoryCapabilities;
  discover?(actor: string, cursor?: string): Promise<DiscoveryResult>;
  joinCandidate?(
    run: RunToken,
    actionId: string,
    candidateId: string,
    signal: AbortSignal,
  ): Promise<MembershipResult>;
  membership?(
    run: RunToken,
    actionId: string,
    conversationId: string,
    operation: "join" | "leave",
    signal: AbortSignal,
  ): Promise<MembershipResult>;
  refresh?(actor: string, conversationId: string, signal: AbortSignal): Promise<MembershipResult>;
  spaces(actor: string): Promise<SpacesResult>;
  members(actor: string, conversationId: string): Promise<MembersResult>;
  openDM(
    run: RunToken,
    actionId: string,
    principal: Exclude<Principal, { kind: "unknown" }>,
    signal: AbortSignal,
  ): Promise<OpenDMResult>;
}

export interface DirectoryCapabilities {
  discover: boolean;
  join: boolean;
  leave: boolean;
  refresh: boolean;
  notes: string[];
}
export interface DiscoveredSpace {
  candidateId: string;
  name?: string | undefined;
  purpose?: string | undefined;
  archived: boolean;
}
export interface DiscoveryResult {
  spaces: DiscoveredSpace[];
  nextCursor: string | null;
  coverage: "public_metadata";
  supported: boolean;
  reason?: string;
}
export interface MembershipResult {
  status: "succeeded" | "failed" | "unknown" | "unsupported";
  conversationId: string;
  active?: boolean;
  reason?: string;
}
