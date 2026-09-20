import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { TypeSafeClient } from '@typesafe-ai/sdk';
it('SQLite rolls back atomically with foreign keys enabled', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    db.exec('CREATE TABLE parent(id TEXT PRIMARY KEY); CREATE TABLE child(id TEXT REFERENCES parent(id));');
    expect(() => db.transaction(() => { db.prepare('INSERT INTO parent VALUES (?)').run('one'); db.prepare('INSERT INTO child VALUES (?)').run('missing'); })()).toThrow();
    expect(db.prepare('SELECT * FROM parent').all()).toEqual([]);
  } finally { db.close(); }
});
it('official Jev SDK sends pinned model and preserves choice probabilities separately from confidence', async () => {
  const client = new TypeSafeClient({ apiKey: 'synthetic', baseURL: 'https://invalid.example', logLevel: 'off',
    defaultModel: 'jev-1.13.0', retry: { maxRetries: 0 }, fetch: async (url, init) => {
      expect(url).toBe('https://invalid.example/v1/systemone');
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'jev-1.13.0', state: { action: '运行测试' } });
      return Response.json({ model: 'jev-1.13.0', answers: { relation: { choice: 'direct', confidence: 0.7, probabilities: { direct: 0.9, unknown: 0.1 } } }, usage: { input_tokens: 5, output_tokens: 2 } });
    } });
  const result = await client.systemOne({ state: { action: '运行测试' }, questions: { relation: { type: 'choice', instructions: 'Classify relation to goal.', criteria: { direct: 'Directly necessary', unknown: 'Insufficient evidence' } } } });
  expect(result.answers.relation.confidence).toBe(0.7);
  expect(result.answers.relation.probabilities.direct).toBe(0.9);
});
