import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * The Agents directory, `data/agents/`. An Agent exists exactly when `<agentId>.sqlite` is in it, so this directory is
 * the only list of Agents. Only names of that exact shape count: a store still being built (`.creating`), SQLite's
 * side files and anything else never stand for an Agent.
 */
export class AgentFiles {
  readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  /** The Agents that exist, in name order. */
  agentIds(): string[] {
    return readdirSync(this.directory)
      .flatMap((name) => {
        const match = STORE.exec(name);
        return match?.[1] === undefined ? [] : [match[1]];
      })
      .sort();
  }

  file(agentId: string): string {
    if (!AGENT_ID.test(agentId)) throw new Error(`not an Agent ID: ${JSON.stringify(agentId)}`);
    return join(this.directory, `${agentId}.sqlite`);
  }

  /** Remove the Agent's store. The store goes first, so the Agent stops existing before its side files go. */
  remove(agentId: string): void {
    const file = this.file(agentId);
    for (const each of [file, `${file}-wal`, `${file}-shm`]) rmSync(each, { force: true });
  }
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const AGENT_ID = new RegExp(`^${UUID}$`);
const STORE = new RegExp(`^(${UUID})\\.sqlite$`);
