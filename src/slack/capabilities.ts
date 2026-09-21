/** Slack API capabilities exercised by this adapter. Manifest scopes are derived from this table. */
export const slackMethods={
 'auth.test':[], 'bots.info':['users:read'],
 'conversations.info':['channels:read','groups:read','im:read','mpim:read'],
 'conversations.list':['channels:read','groups:read','im:read','mpim:read'],
 'conversations.history':['channels:history','groups:history','im:history','mpim:history'],
 'conversations.replies':['channels:history','groups:history','im:history','mpim:history'],
 'conversations.members':['channels:read','groups:read','im:read','mpim:read'],
 'conversations.open':['im:write','mpim:write'],
 'conversations.join':['channels:join'],
 'conversations.leave':['channels:manage','groups:write','im:write','mpim:write'],
 'users.conversations':['channels:read','groups:read','im:read','mpim:read'],
 'users.info':['users:read'],
 'chat.postMessage':['chat:write'], 'chat.postEphemeral':['chat:write'],
 'files.info':['files:read'], 'files.getUploadURLExternal':['files:write'], 'files.completeUploadExternal':['files:write'],
} as const;
export const slackEventSubscriptions=[
 {event:'app_mention',wire:'app_mention',scope:'app_mentions:read'},
 {event:'message.channels',wire:'message',scope:'channels:history'},
 {event:'message.groups',wire:'message',scope:'groups:history'},
 {event:'message.im',wire:'message',scope:'im:history'},
 {event:'message.mpim',wire:'message',scope:'mpim:history'},
 {event:'member_joined_channel',wire:'member_joined_channel',scope:'channels:read'},
 {event:'member_left_channel',wire:'member_left_channel',scope:'channels:read'},
] as const;
export const slackControlCommand='/team';
export const slackWireEvents=Object.freeze([...new Set(slackEventSubscriptions.map(e=>e.wire))]);
export const requiredSlackAppScopes=Object.freeze(['connections:write'] as const);
export const requiredSlackBotScopes=Object.freeze([...new Set<string>([...Object.values(slackMethods).flat(),...slackEventSubscriptions.map(e=>e.scope),'commands'])].sort());
export function slackAppManifest(agentId:string){
 if(!/^[a-z][a-z0-9_-]{0,29}$/.test(agentId))throw new Error('Use a lowercase Agent identifier of at most 30 characters');
 return {display_information:{name:`Mate ${agentId}`,description:'Persistent Mate Agent colleague'},features:{app_home:{home_tab_enabled:false,messages_tab_enabled:true,messages_tab_read_only_enabled:false},bot_user:{display_name:`mate_${agentId}`,always_online:false},slash_commands:[{command:slackControlCommand,description:'Operate Mate',usage_hint:'status',should_escape:false}]},oauth_config:{scopes:{bot:[...requiredSlackBotScopes]}},settings:{socket_mode_enabled:true,event_subscriptions:{bot_events:slackEventSubscriptions.map(e=>e.event)},org_deploy_enabled:false,token_rotation_enabled:false}};
}
