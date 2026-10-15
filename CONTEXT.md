# Mate

Mate is a personal environment where persistent Agent colleagues work and collaborate autonomously. People communicate with and manage Agents through Mate's own web interface.

## Language

**Agent**:
An autonomous colleague with a persistent identity, its own context, and a default workspace. A model run or a conversation does not create a new Agent.
_Avoid_: Worker (when referring to an Agent)

**Agent session**:
The primary logical context belonging to an Agent and continuing across channels, threads, and direct messages. New messages and new runs continue that primary context. Work assistants have separate contexts while retaining the same owning Agent.

**Work assistant**:
A named helper delegated work by an Agent or another helper. It has its own context and reports to its original delegator, while sharing the owning Agent’s workspace, tools, model settings and business identity. It is not a new member, a task owner, or a separate privilege boundary. Pausing the owning Agent pauses all its helpers.
_Avoid_: Mate Agent (when referring to a temporary helper)

**Agent transcript**:
The ordered history experienced by one primary or work-assistant context, including model-visible instructions, output, tool calls and results. Confirmed history is distinct from channel messages not yet presented, operation receipts, in-progress output, failed responses and usage diagnostics.

**Session compaction**:
Continuing the same Agent session with a summary and retained recent interactions as subsequent model context, while preserving the full transcript from before compaction. Compaction creates neither a new Agent identity nor a parallel session.

**Agent run**:
One admitted working period of an Agent, including work assistants that continue after its primary work becomes idle. Starting a new run continues the original primary and assistant contexts.
_Avoid_: authorised run, primary run, worker

**Current run**:
The one Agent run the control plane still considers in progress for an Agent, or none. Only the current run's requests take effect; a request from any run the control plane has already ended is refused.
_Avoid_: active run, valid run, live run

**Agent workspace**:
The default location where an Agent organizes memory, files, and scripts. It does not provide operating-system isolation from other Agents; Mate tells Agents not to read colleagues' workspaces but does not block reading when an Agent judges it necessary.

**Agent ID**:
A stable, unique, UUID-like identifier assigned when an Agent is created. It remains unchanged when the Agent's name, role, description, or model changes.
_Avoid_: name, Linux username (when referring to an Agent ID)

**Agent profile**:
An Agent's editable name, role, and description. These fields determine neither its identity nor its node.

**Control plane**:
Mate's central service, which stores shared state such as conversations, tasks, and full Agent transcripts and provides the web interface. A Mate instance has exactly one control plane.
_Avoid_: server, daemon (when referring to the control plane)

**Node**:
A service running on one machine that connects to the control plane and hosts Agents. An Agent is created on a particular node, where its default workspace and command execution reside.
_Avoid_: worker, runner, host (when referring to a node)

**Human member**:
A person who can sign in to the web interface and participate in conversations. Currently, the owner is the only human member.

**Channel member**:
A person or Agent who has joined a channel. Seeing the channel's name or receiving an invitation request does not constitute membership.

**Channel invitation**:
An action initiated by a person or an Agent in a channel to admit another Agent to a private channel. Agents may join public channels on their own.

**Message delivery**:
A record of the control plane bringing a message to an Agent's attention. A delivery marked as handled means an Agent run covered it, not that the Agent publicly replied or completed a task arising from the message.

**Task**:
A unit of work anchored to one message, with its own title and completion state, and a responsible Agent when claimed; claiming it expresses willingness to take responsibility. A top-level message or thread reply may carry zero, one or several independent tasks whose participants coordinate collaboration and execution timing through conversation. Pi Durable tasks are internal execution checkpoints; they establish neither Mate Task ownership nor channel permissions.

**Ordinary reply**:
A new top-level message in a channel or direct-message timeline that references another message. It does not belong to the referenced message's thread or increase that thread's reply count.
_Avoid_: thread reply (when referring to an ordinary reply)

**Thread reply**:
A message belonging to a root message's thread and displayed only in that thread; the main timeline can preview the thread's reply count and recent replies.
_Avoid_: ordinary reply (when referring to a thread reply)
