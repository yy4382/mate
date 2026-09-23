# Current implementation status

Mate has a Pi Core + pi-ai Agent runtime, SQLite-backed sessions and receipts, Slack and local adapters, tools for communication, tasks, reminders, files, and execution, plus a Debian deployment path. The source and tests are the authority for what already runs. [Project direction](PROJECT_DIRECTION.md) defines the target; [acceptance](ACCEPTANCE.md) defines the release checks.

Execution and deployment are still being brought into line with the Linux-user decision. Do not treat passing tests for superseded code as acceptance of the first release. Ordinary Agent commands should use the Agent's stable Unix identity and native file permissions without work-scoped filesystem grants or mandatory environment-discovery steps. System-privileged commands need a user-visible, per-command approval before execution. The current code must be checked against both requirements before calling the path complete.
