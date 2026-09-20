import { describe, expect, it } from 'vitest';
import { configSchema, requireSecret } from '../src/config.js';

export const configFixture = {
  teamId: 'TTEST', ownerUserIds: ['UOWNER'], jevApiKeyEnv: 'JEV_API_KEY',
  budgets: { maxRuns: 20, maxTokens: 100000, maxCostUsd: 5, runTimeoutMs: 120000 },
  agents: [{ id: 'research', name: 'Research', role: 'Find evidence', slackAppId: 'AONE',
    slackUserId: 'UONE', slackBotId: 'BONE', botTokenEnv: 'RESEARCH_BOT_TOKEN', appTokenEnv: 'RESEARCH_APP_TOKEN',
    model: { provider: 'anthropic', id: 'configured-model', apiKeyEnv: 'MODEL_API_KEY' }, channels: { CTEST: 'mentions' as const } }],
};
describe('trusted configuration', () => {
  it('accepts references without needing credentials for local validation', () => {
    expect(configSchema.parse(configFixture).agents[0]?.id).toBe('research');
  });
  it('rejects duplicate identities and path traversal', () => {
    expect(() => configSchema.parse({ ...configFixture, agents: [...configFixture.agents, ...configFixture.agents] })).toThrow();
    expect(() => configSchema.parse({ ...configFixture, agents: [{ ...configFixture.agents[0], id: '../other' }] })).toThrow();
  });
  it('rejects unknown settings and invalid budgets', () => {
    expect(() => configSchema.parse({ ...configFixture, ownerUserIds: ['UONE'] })).toThrow();
    expect(() => configSchema.parse({ ...configFixture, allowAll: true })).toThrow();
    expect(() => configSchema.parse({ ...configFixture, budgets: { ...configFixture.budgets, maxRuns: 0 } })).toThrow();
  });
  it('fails on missing secrets without dumping the environment', () => {
    expect(() => requireSecret({ SECRET: 'never-print' }, 'MISSING')).toThrow('Missing secret environment variable: MISSING');
  });
});
