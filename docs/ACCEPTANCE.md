# First-release acceptance

Use the current GitHub requirements and work items to decide whether the release is complete. Run `pnpm check` and `pnpm typecheck`, then check these two behaviors:

1. In a local integration test, simulate an Agent asking to run a system-level command. Confirm that the command does not run before user approval, runs once after approval, and does not run when the user rejects it or the approval interface is unavailable. The Agent can see the recorded result.
2. On Debian 13, use two different Linux user accounts for two Agents. Confirm that neither can read the other's private memory; each can read the other's shared work but write only its own; neither can read Mate's database or credentials; and a long-running Agent program can be found and stopped.

Tests that simulate Slack or the model provider do not prove that real accounts can connect. Connecting the real services and installing Mate on the target VPS require separate checks.

## Validation status (2026-09-24)

`pnpm check` passed locally (443 tests passed, 10 skipped), as did `pnpm typecheck`. On a Debian 13.7 VPS, two temporary, unprivileged Linux accounts (UID 1001 and 1002) exercised the native permission boundary with synthetic files under `/tmp/mate-smoke-a9f1`. Before the checks, both private directories and the synthetic control directory existed with mode `0700` and their intended owners; both shared Agent directories existed with mode `0755` and their respective Agent owners. `MEMORY.md` files were installed as `0600`, peer-readable work files as `0644`, and the synthetic control file as root-owned `0600`. Each command ran through `setpriv --reuid=UID --regid=UID --clear-groups` with the relevant Agent UID. The recorded zero/nonzero outcomes were:

| Command and target (repeated for both UIDs) | Outcome |
| --- | --- |
| `dd` from own `private/AGENT/MEMORY.md` and peer `shared/PEER/work.txt` | 0, 0 |
| `dd` from peer `private/PEER/MEMORY.md` and synthetic root-only `control/secret` | nonzero, nonzero |
| `touch` in own `shared/AGENT` and peer `shared/PEER` directories | 0, nonzero |
| `ls /var/lib/mate` and `systemctl --no-ask-password stop mate.service` | nonzero, nonzero |

The test also listed a short-lived systemd scope owned by UID 1001, verified its process UID, stopped it, and found no remaining PIDs. A second scope containing a shell and child `sleep` process likewise stopped with an empty cgroup. The temporary accounts and files were removed; no test scope remained active, and `mate.service` remained inactive. Exact numeric codes and stderr for denied commands were not captured; the result records zero versus nonzero against pre-created paths and known permissions, not the kernel's error category.

This validates the operating-system behavior, not a deployed build of the current Mate release. That VPS had no `/var/lib/mate/state/mate.sqlite` or `/etc/mate/mate.env`, so access to actual Mate database and credential files was not tested; the root-only synthetic control file and inaccessible `/var/lib/mate` directory were substitutes. The real installer, Mate's process-control tool on that VPS, Slack/provider connections, and production account configuration remain unverified.
