import type { RunToken } from '../storage/store.js';
import type { ConversationTarget as Target } from '../domain/conversations.js';
import type { Principal } from '../domain/messages.js';

export interface Space {
  conversationId: string;
  name?: string | undefined;
  purpose?: string | undefined;
  principal?: Principal | undefined;
  archived: boolean;
  kind: 'channel' | 'dm';
}
export interface SpacesResult { spaces: Space[]; incomplete: boolean; retry?: string }
export interface MembersResult { members: Principal[]; incomplete: boolean }
export type OpenDMResult = Target | { status: 'failed'; receipt: unknown };
/** Application-owned port. Provider adapters translate external identifiers. */
export interface ConversationDirectory {
  spaces(actor: string): Promise<SpacesResult>;
  members(actor: string, conversationId: string): Promise<MembersResult>;
  openDM(run: RunToken, actionId: string, principal: Exclude<Principal,{kind:'unknown'}>, signal: AbortSignal): Promise<OpenDMResult>;
}
