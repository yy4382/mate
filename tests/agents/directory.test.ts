import { expect, it } from 'vitest';
import { ConfiguredAgents } from '../../src/agents/directory.js';
import { agentDefinition, agentDefinitionSchema } from '../../src/domain/agents.js';
import { buildBaseline } from '../../src/runtime/prompt.js';
import { configFixture } from '../helpers/config.js';

it('defines independent members without platform installation fields', () => {
  const agent = agentDefinitionSchema.parse({
    id: 'local_peer', name: 'Peer', role: 'Review evidence',
    model: { provider: 'test', id: 'test', apiKeyEnv: 'TEST_MODEL_KEY' },
  });
  const members = new ConfiguredAgents([agent]);
  expect(members.get('local_peer')).toEqual(agent);
  expect(() => members.get('absent')).toThrow('Unknown Agent');
  expect(() => new ConfiguredAgents([agent, agent])).toThrow('Duplicate Agent');
});

it('projects legacy installation fields out and does not expose mutable bootstrap state', () => {
  const input = structuredClone(configFixture.agents[0]!);
  const members = new ConfiguredAgents([input]);
  input.role = 'changed behind the lifecycle service';
  const returned = members.get(input.id);
  returned.model.id = 'changed by a caller';
  members.list()[0]!.role = 'another caller';
  expect(members.get(input.id)).toEqual(agentDefinition(configFixture.agents[0]!));
  expect(members.get(input.id)).not.toHaveProperty('slackUserId');
  expect(members.get(input.id)).not.toHaveProperty('botTokenEnv');
  expect(members.get(input.id)).not.toHaveProperty('channels');
});

it('bases model context on member definition, not platform installation details', () => {
  const agent = configFixture.agents[0]!;
  const first = buildBaseline(agent, 'synthetic tools');
  expect(buildBaseline({ ...agent, slackUserId: 'UOTHER' } as typeof agent, 'synthetic tools')).toEqual(first);
  expect(buildBaseline({ ...agent, role: 'New responsibility' }, 'synthetic tools').configVersion).not.toBe(first.configVersion);
  expect(buildBaseline(agent, 'changed tools').configVersion).not.toBe(first.configVersion);
});
