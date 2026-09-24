# Current implementation status

Mate uses Pi Core and pi-ai to run Agents, SQLite to save their conversation state and action results, and Slack or a local console for human interaction. Agents have tools for messages, tasks, reminders, files, and commands. The source and tests show what works today; [project direction](PROJECT_DIRECTION.md) defines the goal, and [acceptance](ACCEPTANCE.md) lists the release checks.

Execution and deployment still need to be checked against the Linux-user decision. Each Agent should use its own Linux user account for ordinary files and commands, keep the same account and directory paths across commands and Mate restarts, and use normal Linux file permissions for private and shared files. A system-level command must wait for the human user's approval in Slack before it runs. Passing tests for earlier execution code does not establish that these requirements are met.
