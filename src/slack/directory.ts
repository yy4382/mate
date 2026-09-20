import type { WebClient } from '@slack/web-api';
import type { RunToken } from '../storage/store.js';
import type { Messages } from './messages.js';

/** Identity and membership come from the acting bot's authenticated Slack client. */
export class Directory {
  constructor(readonly messages: Messages, readonly clients: Map<string, WebClient>) {}
  private client(actor: string): WebClient {
    this.messages.agent(actor);
    const client = this.clients.get(actor); if (!client) throw new Error('Slack client unavailable'); return client;
  }
  async spaces(actor: string): Promise<unknown> {
    const client = this.client(actor), spaces = [], channels = [];
    const version = this.messages.membershipVersion(actor); let cursor: string | undefined, pages = 0;
    do {
      const result = await client.users.conversations({ types: 'public_channel,private_channel,im,mpim', limit: 200, ...(cursor ? { cursor } : {}) });
      for (const c of result.channels ?? []) if (c.id && /^[CDG][A-Z0-9]+$/.test(c.id)) {
        channels.push(c);
        spaces.push({ channel: c.id, name: c.name, purpose: c.purpose?.value, user: c.user, archived: !!c.is_archived, kind: c.is_im ? 'dm' : 'channel' });
      }
      cursor = result.response_metadata?.next_cursor || undefined; pages++;
    } while (cursor && pages < 10);
    if (version !== this.messages.membershipVersion(actor)) return { spaces: [], incomplete: true, retry: 'membership changed during discovery' };
    for (const c of channels) {
      this.messages.membership(actor, c.id!, !c.is_archived);
      if (c.is_im && c.user && !c.is_archived) this.messages.store.db.prepare("UPDATE actions SET state='succeeded',receipt=? WHERE agent_id=? AND state='unknown' AND json_extract(request,'$.operation')='conversations.openDM' AND json_extract(request,'$.user')=?").run(JSON.stringify({channel:c.id}), actor, c.user);
    }
    return { spaces, incomplete: !!cursor };
  }
  async members(actor: string, channel: string): Promise<unknown> {
    this.messages.requireAccess(actor, channel);
    const client = this.client(actor), members: string[] = []; let cursor: string | undefined, pages = 0;
    do {
      const result = await client.conversations.members({ channel, limit: 200, ...(cursor ? { cursor } : {}) });
      members.push(...(result.members ?? [])); cursor = result.response_metadata?.next_cursor || undefined; pages++;
    } while (cursor && pages < 10);
    this.messages.requireAccess(actor, channel);
    return { members, incomplete: !!cursor };
  }
  async openDM(run: RunToken, actionId: string, user: string, signal: AbortSignal): Promise<unknown> {
    const s = this.messages.store, client = this.client(run.agentId);
    s.assertRun(run); signal.throwIfAborted();
    if (!/^U[A-Z0-9]+$/.test(user)) throw new Error('Invalid Slack user');
    const action = s.prepareAction(run, actionId, { operation: 'conversations.openDM', user });
    if (action.state === 'succeeded') return JSON.parse(action.receipt!);
    if (action.state === 'failed') return { status: 'failed', receipt: JSON.parse(action.receipt!) };
    if (action.state !== 'prepared' || s.db.prepare("SELECT 1 FROM actions WHERE agent_id=? AND state IN ('executing','unknown') AND json_extract(request,'$.operation')='conversations.openDM' AND json_extract(request,'$.user')=?").get(run.agentId, user)) throw new Error('DM opening outcome unknown; inspect spaces before retry');
    const identity = await client.users.info({ user });
    if (identity.user?.id !== user || identity.user.deleted || (identity.user.team_id && identity.user.team_id !== this.messages.config.teamId)) throw new Error('User is not an active workspace member');
    signal.throwIfAborted(); s.startAction(run, actionId);
    try {
      const result = await client.conversations.open({ users: user, return_im: true });
      if (!result.channel?.id || !/^D[A-Z0-9]+$/.test(result.channel.id)) throw new Error('Invalid DM receipt');
      signal.throwIfAborted(); s.assertRun(run);
      const target = { channel: result.channel.id };
      s.atomic(() => { this.messages.membership(run.agentId, target.channel, true); s.settleAction(run, actionId, 'succeeded', target); });
      return target;
    } catch (error) {
      const failure = error as {code?: string; data?: {error?: string}};
      const rejected = failure.code === 'slack_webapi_rate_limited_error' || failure.code === 'slack_webapi_platform_error' && ['missing_scope','invalid_auth','not_authed','token_revoked','account_inactive','user_not_found','user_not_visible','cannot_dm_bot','cannot_dm_self','restricted_action','no_permission','user_disabled','users_not_found','invalid_users','invalid_arguments','invalid_arg_name','invalid_array_arg','invalid_charset','invalid_form_data','invalid_post_type','invalid_types','method_not_supported_for_channel_type','not_allowed_token_type','access_denied','accesslimited','channel_not_found','deprecated_endpoint','ekm_access_denied','enterprise_is_restricted','invalid_user_combination','method_deprecated','missing_post_type','not_enough_users','org_login_required','ratelimited','team_access_not_granted','too_many_users','token_expired','user_is_bot','user_is_restricted','user_not_found','user_not_visible'].includes(failure.data?.error ?? '');
      try { s.settleAction(run, actionId, rejected ? 'failed' : 'unknown', { reason: rejected ? (failure.data?.error ?? failure.code) : 'DM opening or receipt uncertain' }); } catch { /* run fenced */ }
      throw error;
    }
  }
}
