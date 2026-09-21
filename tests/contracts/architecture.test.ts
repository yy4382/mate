import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { expect, it } from 'vitest';

const sourceRoot = resolve('src');
const applicationLayers = new Set([
  'conversations', 'collaboration', 'coordination', 'reminders',
  'runtime', 'budget', 'policy', 'capabilities', 'domain', 'agents',
]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.m?ts$/.test(path) ? [path] : [];
  });
}

// Conservative source check of literal module specifiers, including type imports.
// This is an engineering regression check, not an execution security boundary.
function dependencies(text: string): string[] {
  const imports: string[] = [];
  const specifiers = /(?:\bfrom\s*|\b(?:import|require)\s*\(\s*|\bimport\s*)(['"])([^'"\n]+)\1/g;
  for (const match of text.matchAll(specifiers)) imports.push(match[2]!);
  return imports;
}

it('keeps application services independent of adapters and daemon composition', () => {
  const violations: string[] = [];
  for (const path of sourceFiles(sourceRoot)) {
    const name = relative(sourceRoot, path);
    if (!applicationLayers.has(name.split('/')[0]!)) continue;
    for (const dependency of dependencies(readFileSync(path, 'utf8'))) {
      const destination = dependency.startsWith('.')
        ? relative(sourceRoot, resolve(dirname(path), dependency)) : dependency;
      if (/^(slack|daemon|adapters)\//.test(destination) || destination.startsWith('@slack/')) {
        violations.push(`${name} → ${dependency}`);
      }
    }
  }
  expect(violations).toEqual([]);
});

it('recognizes type-only and indirect import syntax in boundary checks', () => {
  expect(dependencies(`
    import type { DTO } from '../daemon/a.js';
    export * from '../slack/b.js';
    type T = import('../daemon/c.js').DTO;
    const d = import('@slack/web-api');
    const e = require('../adapters/e.js');
  `)).toEqual(['../daemon/a.js', '../slack/b.js', '../daemon/c.js', '@slack/web-api', '../adapters/e.js']);
});
