# Deployment configuration

The configuration separates Mate's Agent team from Slack accounts. `mate.agents` lists each Agent's identifier, name, role, model, and the environment-variable name used for its model-provider credential. `mate.ownerUserIds` lists the people allowed to administer Mate, using Mate's own identifiers for those people rather than Slack user IDs.

`adapters.slack` identifies the Slack workspace, maps each Slack user ID to one Mate human identifier, and associates each connected Agent with its own Slack app, bot identity, credential-variable names, and channel participation settings. An Agent without a Slack app cannot use another Agent's bot token.

`adapters.local` names the people and rooms available through the local console. Only the host configuration can assign these identities; an Agent cannot claim to be a human by sending text. Mate can run without Slack; the `local` command reads one JSON request per input line from the host. See [本地开发入口](DEVELOPMENT.md).

The Slack user-to-human mapping identifies which real person sent a message or approved a system-level command. Removing a person from `mate.ownerUserIds` removes their owner powers; it does not change the identity recorded on earlier messages. Mate applies a changed configuration the next time it starts: stop Mate, replace the configuration file, and start it again. Sessions, deliveries, tasks, reminders and identity survive the change, and an Agent whose baseline changed starts a fresh context that keeps its journal. Existing Agent identities cannot be removed or rebound, and a database whose Agents are missing from the configuration is refused with the next action instead of being adopted. `runtime.dataDir` selects which database Mate opens: keeping it keeps continuity, while a new, empty directory starts a new deployment and leaves the old directory untouched.

Provider and Slack token values stay in environment variables; configuration contains only secret reference names. `check` reports model availability and missing references for the complete team and configured installations.

For Debian 13 installation and Linux-user directory layout, see [部署与运维](OPERATIONS.md).
