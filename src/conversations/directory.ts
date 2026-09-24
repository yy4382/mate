import type { RunToken } from "../storage/store.js";
import type { ConversationTarget as Target } from "../domain/conversations.js";
import type { Principal } from "../domain/messages.js";

export interface Space {
  conversationId: string;
  /** Who decides membership: the Mate host for internal rooms, the platform for external ones. */
  source: "internal" | "external";
  kind: "channel" | "dm";
  name?: string | undefined;
  purpose?: string | undefined;
  principal?: Principal | undefined;
  archived: boolean;
}
/** Whether one source's catalog was read completely, and why not when it was not. */
export interface SpaceCoverage {
  source: "internal" | "external";
  complete: boolean;
  reason?: string | undefined;
}
export interface SpacesResult {
  spaces: Space[];
  coverage: SpaceCoverage[];
}
export interface MembersResult {
  members: Principal[];
  incomplete: boolean;
}
export type OpenDMResult = Target | { status: "failed"; receipt: unknown };
/**
 * Definite outcome of one channel invitation, or an unconfirmed external effect. Only a membership
 * fact the platform confirms grants the invited Agent access; an extended request does not.
 */
export interface InviteResult {
  status: "succeeded" | "failed" | "unknown";
  conversationId: string;
  agentId: string;
  /** How a definite result was established when the invitation response did not state it. */
  verification?: "membership_query" | undefined;
  /** Platform reason for a definite failure, or why the outcome stays unknown. */
  reason?: string | undefined;
}
/** Membership as the platform currently reports it for one external conversation. */
export interface MembershipObservation {
  status: "succeeded" | "unsupported";
  conversationId: string;
  active?: boolean | undefined;
  reason?: string | undefined;
}
/** Application-owned port. Provider adapters translate external identifiers. */
export interface ConversationDirectory {
  refresh?(
    actor: string,
    conversationId: string,
    signal: AbortSignal,
  ): Promise<MembershipObservation>;
  /**
   * Invites one configured team Agent to an external channel the acting Agent is already in. The
   * target is named by team identity; an adapter resolves it through its own installation mapping.
   * An adapter refuses a target that is not another configured team Agent, the acting Agent itself,
   * an internal room, and any conversation the platform does not let this installation invite to.
   */
  invite?(
    run: RunToken,
    actionId: string,
    conversationId: string,
    agentId: string,
    signal: AbortSignal,
  ): Promise<InviteResult>;
  spaces(actor: string): Promise<SpacesResult>;
  members(actor: string, conversationId: string): Promise<MembersResult>;
  openDM(
    run: RunToken,
    actionId: string,
    principal: Exclude<Principal, { kind: "unknown" }>,
    signal: AbortSignal,
  ): Promise<OpenDMResult>;
}
