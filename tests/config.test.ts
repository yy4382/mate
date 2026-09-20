import { describe, expect, it } from 'vitest';
import { configSchema, requireSecret } from '../src/config.js';

import { configFixture } from './helpers/config.js';
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
