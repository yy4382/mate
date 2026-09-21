import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {backup} from '../dist/src/daemon/backup.js';
import {daemonConfigSchema} from '../dist/src/daemon/config.js';
import {restoreCheckpoint} from '../dist/src/daemon/restore.js';
import {Store} from '../dist/src/storage/store.js';

const [mode, root] = process.argv.slice(2);
if (!mode || !root) throw new Error('Usage: validate-v2b-native.mjs MODE ROOT');
const data = join(root, 'data');
const config = daemonConfigSchema.parse(JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')));
const checkpoint = name => join(root, 'backups', name);
const memory = agent => join(data, 'agents', agent, 'MEMORY.md');

async function createCheckpoint(name, label, mutateDatabase = false) {
  for (const agent of config.mate.agents) {
    const workspace = join(data, 'agents', agent.id);
    mkdirSync(join(workspace, 'notes'), {recursive: true, mode: 0o750});
    writeFileSync(memory(agent.id), `${label}-${agent.id}`, {mode: 0o640});
    writeFileSync(join(workspace, 'notes', 'evidence.txt'), label, {mode: 0o600});
  }
  const store = new Store(join(data, 'state', 'mate.sqlite'));
  try {
    for (const agent of config.mate.agents) {
      if (!store.db.prepare('SELECT 1 FROM agents WHERE id=?').get(agent.id)) store.register(agent.id, 'native-v2b', [{role: 'user', content: label}]);
    }
    if (mutateDatabase) store.audit('native-newer', {label});
    await backup(store, data, checkpoint(name), config);
  } finally {
    store.close();
  }
}

if (mode === 'target') {
  await createCheckpoint('target', 'target');
} else if (mode === 'current') {
  await createCheckpoint('current', 'current', true);
} else if (mode === 'post') {
  await createCheckpoint('post', 'target');
} else if (mode === 'capacity') {
  try {
    await restoreCheckpoint(config, checkpoint('target'), {currentCheckpoint: checkpoint('current')});
    throw new Error('Expected capacity refusal');
  } catch (error) {
    if (!String(error).includes('capacity')) throw error;
    if (existsSync(join(data, 'control', 'restore.json'))) throw new Error('Capacity refusal persisted a restore decision');
  }
} else if (mode === 'kill-agent') {
  await restoreCheckpoint(config, checkpoint('target'), {
    currentCheckpoint: checkpoint('current'),
    afterPhase(phase) { if (phase === 'agent:research') process.kill(process.pid, 'SIGKILL'); },
  });
  throw new Error('Restore was not killed');
} else if (mode === 'resume-target') {
  await restoreCheckpoint(config, checkpoint('target'));
} else if (mode === 'decide-current') {
  try {
    await restoreCheckpoint(config, checkpoint('current'), {
      currentCheckpoint: checkpoint('post'),
      afterPhase(phase) { if (phase === 'decision') throw new Error('native stop after decision'); },
    });
  } catch (error) {
    if (!String(error).includes('native stop after decision')) throw error;
  }
} else if (mode === 'resume-current') {
  await restoreCheckpoint(config, checkpoint('current'));
} else if (mode === 'assert-mid') {
  if (readFileSync(memory('research'), 'utf8') !== 'target-research') throw new Error('First Agent root was not restored');
  if (readFileSync(memory('writer'), 'utf8') !== 'current-writer') throw new Error('Second Agent root changed before its phase');
  const store = new Store(join(data, 'state', 'mate.sqlite'));
  try { if (store.db.prepare("SELECT count(*) n FROM audit WHERE kind='native-newer'").get().n !== 1) throw new Error('Database changed before its final phase'); }
  finally { store.close(); }
} else if (mode === 'assert-final') {
  for (const agent of config.mate.agents) if (readFileSync(memory(agent.id), 'utf8') !== `current-${agent.id}`) throw new Error(`Final workspace mismatch: ${agent.id}`);
  if (readFileSync(join(config.runtime.workspaceGrants[0].root, 'sentinel'), 'utf8') !== 'external-untouched') throw new Error('External workspace was modified');
  if (existsSync(join(data, 'control', 'restore.json'))) throw new Error('Restore journal was not removed');
  const store = new Store(join(data, 'state', 'mate.sqlite'));
  try { if (store.db.prepare("SELECT count(*) n FROM audit WHERE kind='native-newer'").get().n !== 1) throw new Error('Final database mismatch'); }
  finally { store.close(); }
} else {
  throw new Error(`Unknown mode: ${mode}`);
}
