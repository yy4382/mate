# Local daemon console

The local console uses the same Daemon, Supervisor, tools, conversation storage, submission gate and owner controls as Slack. It is a trusted host interface, not a network authentication service. Do not expose stdin as a public endpoint that accepts a caller-selected identity.

Configure version 2 with pure `mate.agents`, internal `mate.ownerUserIds`, runtime/data directory and, for example:

```json
{"local":{"humans":["owner"],"rooms":[{"id":"team-room","agents":["research"],"humans":["owner"]}]}}
```

This object is the value of `adapters`. Add `adapters.slack` to use both entry points. Model credentials are still needed for actual model calls. No Slack credentials or synthetic Slack IDs are required in local-only mode.

Build with pnpm, then run `node dist/src/main.js local /absolute/config.json`. Send one JSON object per line; each response has the same `id` and either `result` or `error`. Logs go to stderr. EOF closes the console and daemon; `start` is the unattended daemon command.

```json
{"id":"rooms","op":"rooms","human":"owner"}
{"id":"send","op":"send","human":"owner","eventId":"unique-request-1","target":{"conversationId":"team-room"},"text":"Investigate this question"}
{"id":"read","op":"read","human":"owner","target":{"conversationId":"team-room"}}
{"id":"status","op":"control","human":"owner","text":"status"}
```

`send` has a durable `eventId`: repeating the same identity and contents returns the same message; changing contents under that identity is rejected. Replies use `target.threadId` from the returned canonical message ID. `read` returns at most 100 nondeleted messages newest first and a `nextCursor`; supply it as `before` to continue. Human room membership is checked for reads and sends. Controls additionally require the configured internal owner permission.

Room configuration seeds membership once. Restarting does not regrant revoked Agent or human access. Membership changes require offline configuration migration; unchanged members keep their current revoked state. Removing a configured room revokes its configured members and preserves history. Explicitly adding that local-owned room back via migration grants the newly requested membership. A local room cannot adopt an unrelated internal DM or external conversation.

Slack sockets, HTTP calls, history/reconciliation, projections and attachment downloads belong to the Slack adapter. Local/core scheduling does not wait for its periodic network maintenance. Internal output commits use a separate local queue from external sends; both retain their existing per-conversation ordering because authority is immutable. Shutdown stops adapters and drains work before closing SQLite and releasing its process lock. The Linux execution and VPS packaging acceptance gates remain separate; these local tests do not claim Linux isolation or real Slack connectivity.
