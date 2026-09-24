# First-release acceptance

Use the current GitHub requirements and work items to decide whether the release is complete. Run `pnpm check` and `pnpm typecheck`, then check these two behaviors:

1. In a local integration test, simulate an Agent asking to run a system-level command. Confirm that the command does not run before user approval, runs once after approval, and does not run when the user rejects it or the approval interface is unavailable. The Agent can see the recorded result.
2. On Debian 13, use two different Linux user accounts for two Agents. Confirm that neither can read the other's private memory; each can read the other's shared work but write only its own; neither can read Mate's database or credentials; and a long-running Agent program can be found and stopped.

Tests that simulate Slack or the model provider do not prove that real accounts can connect. Connecting the real services and installing Mate on the target VPS require separate checks.
