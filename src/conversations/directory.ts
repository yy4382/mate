import type { RunToken } from '../storage/store.js';
import type { Target } from './messages.js';

export interface Space {
  channel: string;
  name?: string | undefined;
  purpose?: string | undefined;
  user?: string | undefined;
  archived: boolean;
  kind: 'channel' | 'dm';
}
export interface SpacesResult { spaces: Space[]; incomplete: boolean; retry?: string }
export interface MembersResult { members: string[]; incomplete: boolean }
export type OpenDMResult = Target | { status: 'failed'; receipt: unknown };
/** Application-owned port. E1 retains legacy reference shapes until E2 migration. */
export interface ConversationDirectory {
  spaces(actor: string): Promise<SpacesResult>;
  members(actor: string, channel: string): Promise<MembersResult>;
  openDM(run: RunToken, actionId: string, user: string, signal: AbortSignal): Promise<OpenDMResult>;
}
