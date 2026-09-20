import { realpathSync } from 'node:fs';
import { hash } from '../storage/store.js';
/** Identical scope for live startup, offline recovery, and backups even through parent aliases. */
export function executionScope(dataDir: string): string { return `mate-${hash(realpathSync(dataDir)).slice(0, 24)}`; }
