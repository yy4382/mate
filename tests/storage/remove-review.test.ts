import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/storage/store.js';
import { schema, messageSchema, collaborationSchema, policySchema, runtimeSchema, daemonSchema } from '../../src/storage/schema.js';
it('v6 review retirement preserves history and unknown effects without auto-authorizing legacy exec grants', () => {
  const root = mkdtempSync(join(tmpdir(), 'mate-v7-')), path = join(root, 'state.sqlite');
  const old = new Database(path);
  old.exec([schema, messageSchema, collaborationSchema, policySchema, runtimeSchema, daemonSchema].join('\n'));
  old.exec(`
    INSERT INTO agents(id,session_id) VALUES('research','session');
    INSERT INTO sessions VALUES('session','research','v1');
    INSERT INTO entries VALUES('session',1,'initial','{"role":"user","content":"synthetic history"}');
    INSERT INTO deliveries(id,agent_id,dedupe,payload,priority,created_at) VALUES('delivery','research','approval:a','{"kind":"approval"}',50,1);
    INSERT INTO runs(id,agent_id,session_id,generation,delivery_id,state,created_at) VALUES('run','research','session',1,'delivery','complete',1);
    INSERT INTO works(id,origin,target,max_runs,max_tokens,max_cost) VALUES('work','human:one','{}',10,10000,1);
    INSERT INTO grants(id,agent_id,work_id,root,operations,expires) VALUES('exec','research','work','/synthetic/project','["read","write","exec"]',9999999999999);
    INSERT INTO grants(id,agent_id,work_id,root,operations,expires) VALUES('memory','research','work','/synthetic/memory','["read","write"]',9999999999999);
    INSERT INTO actions VALUES('a','research','run','hash','{"operation":{"kind":"exec"}}','prepared',NULL);
    INSERT INTO actions VALUES('unknown','research','run','hash','{"operation":{"kind":"exec"}}','unknown',NULL);
    INSERT INTO approvals(id,agent_id,work_id,run_id,grant_id,request_hash,expires,policy_version) VALUES('a','research','work','run','exec','hash',9999999999999,'old');
    INSERT INTO blocked_runs VALUES('run');
    INSERT INTO outbox VALUES('approval-notice:a','research','hash','{}','pending',NULL);
  `); old.close();
  let store = new Store(path);
  try {
    expect(store.db.pragma('user_version',{simple:true})).toBe(16);
    expect(store.db.prepare("SELECT name FROM sqlite_master WHERE name IN ('approvals','blocked_runs')").all()).toEqual([]);
    expect((store.db.pragma('table_info(grants)') as {name:string}[]).map(c=>c.name)).not.toContain('exec_allowlist');
    expect(store.db.prepare('SELECT id,revoked FROM grants ORDER BY id').all()).toEqual([{id:'exec',revoked:1},{id:'memory',revoked:0}]);
    expect(store.action('a')?.state).toBe('failed'); expect(store.action('unknown')?.state).toBe('unknown');
    expect(store.delivery('delivery').status).toBe('handled'); expect(store.output('approval-notice:a')?.state).toBe('failed');
    expect(store.journal('session')).toEqual([{role:'user',content:'synthetic history'}]);
    expect(store.db.prepare("SELECT count(*) n FROM audit WHERE kind='retired_command_review'").get()).toEqual({n:1});
    store.close(); store = new Store(path);
    expect(store.action('a')?.state).toBe('failed'); expect(store.journal('session')).toHaveLength(1);
  } finally { store.close(); rmSync(root,{recursive:true,force:true}); }
});
