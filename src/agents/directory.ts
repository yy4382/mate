import { agentDefinition, type AgentDefinition } from '../domain/agents.js';

/** Runtime consumers query identities, not platform installations. */
export interface AgentDirectory {
  list(): AgentDefinition[];
  get(id: string): AgentDefinition;
}

/** Experiment bootstrap. Lifecycle writes will replace this provider, not runtime APIs. */
export class ConfiguredAgents implements AgentDirectory {
  private readonly definitions = new Map<string, AgentDefinition>();

  constructor(agents: readonly AgentDefinition[]) {
    for (const input of agents) {
      const definition = agentDefinition(input);
      if (this.definitions.has(definition.id)) throw new Error(`Duplicate Agent identity: ${definition.id}`);
      this.definitions.set(definition.id, definition);
    }
  }

  list(): AgentDefinition[] {
    return [...this.definitions.values()].map(definition => structuredClone(definition));
  }

  get(id: string): AgentDefinition {
    const definition = this.definitions.get(id);
    if (!definition) throw new Error('Unknown Agent');
    return structuredClone(definition);
  }
}
