import Database from 'better-sqlite3';
import { chmodSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { schema, messageSchema, collaborationSchema, policySchema, runtimeSchema, daemonSchema, scopedExecutionSchema, conversationSchema, budgetSchema, attentionSchema, freshnessSchema, reviewSeatSchema, messageTaskSchema } from './schema.js';

export function encode(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Value is not JSON');
  return encoded;
}
export function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export interface RunToken { id: string; agentId: string; sessionId: string; generation: number; deliveryId: string }
export interface Delivery { id: string; agent_id: string; payload: string; status: string; created_at: number; priority: number }
export interface Effect { id: string; agent_id: string; request_hash: string; request: string; state: string; receipt: string | null }

/** Only the trusted daemon owns this connection; never expose SQL over worker IPC. */
export class Store {
  readonly db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('foreign_keys = ON'); this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL'); this.db.pragma('busy_timeout = 5000');
    const version = this.db.pragma('user_version', { simple: true });
    if (Number(version) > 0 && Number(version) < 13 && path !== ':memory:') {
      // SQLite creates a consistent backup before changing any legacy schema.
      const backup = `${path}.pre-v${Number(version) < 8 ? 8 : Number(version) < 9 ? 9 : Number(version) < 10 ? 10 : Number(version) < 11 ? 11 : Number(version) < 12 ? 12 : 13}-${randomUUID()}.sqlite`;
      this.db.prepare('VACUUM INTO ?').run(backup); chmodSync(backup, 0o600);
    }
    if (version === 0) this.atomic(() => this.db.exec(schema));
    else if (![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].includes(Number(version))) { this.db.close(); throw new Error('Unsupported database version'); }
    if (Number(version) < 2) this.atomic(() => this.db.exec(messageSchema));
    if (Number(version) < 3) this.atomic(() => this.db.exec(collaborationSchema));
    if (Number(version) < 4) this.atomic(() => this.db.exec(policySchema));
    if (Number(version) < 5) this.atomic(() => this.db.exec(runtimeSchema));
    if (Number(version) < 6) this.atomic(() => this.db.exec(daemonSchema));
    if (Number(version) < 7) this.atomic(() => this.db.exec(scopedExecutionSchema));
    if (Number(version) < 8) this.atomic(() => this.db.exec(conversationSchema));
    if (Number(version) < 9) this.atomic(() => this.db.exec(budgetSchema));
    if (Number(version) < 10) this.atomic(() => this.db.exec(attentionSchema));
    if(Number(version)<11){
      this.db.pragma('foreign_keys = OFF');
      try{this.atomic(()=>{this.db.exec(freshnessSchema);if((this.db.pragma('foreign_key_check') as unknown[]).length)throw new Error('Freshness migration foreign key failure');});}
      finally{this.db.pragma('foreign_keys = ON');}
    }
    if(Number(version)<12)this.atomic(()=>this.db.exec(reviewSeatSchema));
    if(Number(version)<13)this.atomic(()=>this.db.exec(messageTaskSchema));
  }
  atomic<T>(fn: () => T): T { return this.db.transaction(fn).immediate(); }
  close(): void { this.db.close(); }
  async backup(path: string): Promise<void> { await this.db.backup(path); }
  audit(kind: string, body: unknown): void { this.db.prepare('INSERT INTO audit(at,kind,body) VALUES(?,?,?)').run(Date.now(), kind, encode(body)); }
  register(agentId: string, configVersion: string, initialMessages: unknown[]): string {
    return this.atomic(() => {
      const old = this.db.prepare('SELECT s.id,s.config_version FROM sessions s JOIN agents a ON a.session_id=s.id WHERE a.id=?').get(agentId) as { id: string; config_version: string } | undefined;
      if (old) {
        if (old.config_version !== configVersion) throw new Error('Session configuration requires explicit migration');
        return old.id;
      }
      const sessionId = randomUUID();
      this.db.prepare('INSERT INTO agents(id,session_id) VALUES(?,?)').run(agentId, sessionId);
      this.db.prepare('INSERT INTO sessions(id,agent_id,config_version) VALUES(?,?,?)').run(sessionId, agentId, configVersion);
      initialMessages.forEach((message, i) => this.append(sessionId, `initial:${i}`, message));
      return sessionId;
    });
  }
  private append(sessionId: string, key: string, message: unknown): void {
    const body = encode(message);
    const old = this.db.prepare('SELECT message FROM entries WHERE session_id=? AND key=?').get(sessionId, key) as { message: string } | undefined;
    if (old) { if (old.message !== body) throw new Error('Journal key reused with different message'); return; }
    this.db.prepare('INSERT INTO entries(session_id,seq,key,message) SELECT ?,COALESCE(MAX(seq),0)+1,?,? FROM entries WHERE session_id=?').run(sessionId, key, body, sessionId);
  }
  enqueue(agentId: string, dedupe: string, payload: unknown, priority = 0, now = Date.now()): string {
    return this.atomic(() => {
      const old = this.db.prepare('SELECT id FROM deliveries WHERE agent_id=? AND dedupe=?').get(agentId, dedupe) as { id: string } | undefined;
      if (old) return old.id;
      const id = randomUUID();
      this.db.prepare('INSERT INTO deliveries(id,agent_id,dedupe,payload,priority,created_at) VALUES(?,?,?,?,?,?)').run(id, agentId, dedupe, encode(payload), priority, now);
      return id;
    });
  }
  beginRun(agentId: string, now = Date.now(), requireWork = false): RunToken | undefined {
    return this.atomic(() => {
      const agent = this.db.prepare('SELECT * FROM agents WHERE id=?').get(agentId) as { session_id: string; generation: number; paused: number } | undefined;
      if (!agent || agent.paused || this.db.prepare("SELECT 1 FROM runs WHERE agent_id=? AND state='active'").get(agentId)) return;
      const delivery = this.db.prepare("SELECT d.* FROM deliveries d LEFT JOIN delivery_work dw ON dw.delivery_id=d.id LEFT JOIN delivery_context dc ON dc.delivery_id=d.id LEFT JOIN works w ON w.id=COALESCE(dc.work_id,dw.work_id) WHERE d.agent_id=? AND (?=0 OR w.id IS NOT NULL) AND d.status!='handled' AND (w.id IS NULL OR w.state='active') AND COALESCE(json_extract(d.payload,'$.notBefore'),0)<=? ORDER BY (d.priority + (? - d.created_at)/60000) DESC,d.created_at,d.id LIMIT 1").get(agentId, Number(requireWork), now, now) as Delivery | undefined;
      if (!delivery) return;
      const token = { id: randomUUID(), agentId, sessionId: agent.session_id, generation: agent.generation + 1, deliveryId: delivery.id };
      this.db.prepare('UPDATE agents SET generation=? WHERE id=?').run(token.generation, agentId);
      this.db.prepare("INSERT INTO runs(id,agent_id,session_id,generation,delivery_id,state,created_at) VALUES(?,?,?,?,?,'active',?)").run(token.id, agentId, token.sessionId, token.generation, token.deliveryId, now);
      this.db.prepare('UPDATE deliveries SET run_id=? WHERE id=?').run(token.id, delivery.id);
      return token;
    });
  }
  assertRun(token: RunToken): void {
    if (!this.db.prepare("SELECT 1 FROM runs r JOIN agents a ON a.id=r.agent_id WHERE r.id=? AND r.agent_id=? AND r.session_id=? AND r.generation=? AND r.delivery_id=? AND r.state='active' AND a.generation=r.generation AND a.paused=0").get(token.id, token.agentId, token.sessionId, token.generation, token.deliveryId)) throw new Error('Stale or stopped run');
  }
  input(token: RunToken, message: unknown): void {
    this.atomic(() => {
      this.assertRun(token);
      this.append(token.sessionId, `delivery:${token.deliveryId}`, message);
      this.db.prepare("UPDATE deliveries SET status='injected' WHERE id=?").run(token.deliveryId);
    });
  }
  appendMessage(token: RunToken, key: string, message: unknown): void {
    this.atomic(() => { this.assertRun(token); this.append(token.sessionId, `${token.id}:${key}`, message); });
  }
  finish(token: RunToken, error?: string): void {
    this.atomic(() => {
      this.assertRun(token);
      const delivery = this.delivery(token.deliveryId);
      if (!error && delivery.status !== 'injected') throw new Error('Cannot complete uninjected delivery');
      if (!error && this.db.prepare("SELECT 1 FROM actions WHERE run_id=? AND state='executing'").get(token.id)) throw new Error('Cannot complete with executing actions');
      if (error) this.db.prepare("UPDATE actions SET state='unknown' WHERE run_id=? AND state='executing'").run(token.id);
      this.db.prepare('UPDATE runs SET state=?,error=? WHERE id=?').run(error ? 'failed' : 'complete', error ?? null, token.id);
      if (!error) this.db.prepare("UPDATE deliveries SET status='handled' WHERE id=?").run(token.deliveryId);
      // Failed input remains durable, but requires explicit resume to avoid an error hot loop.
      else this.db.prepare('UPDATE agents SET paused=1 WHERE id=?').run(token.agentId);
    });
  }
  delivery(id: string): Delivery {
    const row = this.db.prepare('SELECT * FROM deliveries WHERE id=?').get(id) as Delivery | undefined;
    if (!row) throw new Error('Unknown delivery'); return row;
  }
  pause(agentId: string): void {
    this.atomic(() => {
      this.db.prepare('UPDATE agents SET paused=1,generation=generation+1 WHERE id=?').run(agentId);
      this.db.prepare("UPDATE runs SET state='interrupted' WHERE agent_id=? AND state='active'").run(agentId);
      this.db.prepare("UPDATE actions SET state='unknown' WHERE agent_id=? AND state='executing'").run(agentId);
    });
  }
  resume(agentId: string): void { this.db.prepare('UPDATE agents SET paused=0 WHERE id=?').run(agentId); }
  /** Call only after obtaining the daemon single-instance lock and terminating old workers. */
  recover(): void {
    this.atomic(() => {
      this.db.prepare('UPDATE agents SET generation=generation+1').run();
      this.db.prepare("UPDATE runs SET state='interrupted' WHERE state='active'").run();
      this.db.prepare("UPDATE actions SET state='unknown' WHERE state='executing'").run();
      this.db.prepare("UPDATE outbox SET state='unknown' WHERE state='sending'").run();
      this.audit('startup_recovery', {});
    });
  }
  journal(sessionId: string): unknown[] { return (this.db.prepare('SELECT message FROM entries WHERE session_id=? ORDER BY seq').all(sessionId) as { message: string }[]).map(r => JSON.parse(r.message)); }
  snapshot(sessionId: string, messages: unknown[]): void {
    this.atomic(() => {
      if (this.db.prepare("SELECT 1 FROM runs WHERE session_id=? AND state='active'").get(sessionId)) throw new Error('Snapshot requires idle session');
      const { seq } = this.db.prepare('SELECT COALESCE(MAX(seq),0) seq FROM entries WHERE session_id=?').get(sessionId) as { seq: number };
      const body = encode(messages);
      this.db.prepare('INSERT INTO snapshots VALUES(?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET watermark=excluded.watermark,body=excluded.body,hash=excluded.hash').run(sessionId, seq, body, hash(body));
    });
  }
  context(sessionId: string): unknown[] {
    const snap = this.db.prepare('SELECT * FROM snapshots WHERE session_id=?').get(sessionId) as { body: string; hash: string; watermark: number } | undefined;
    if (!snap || hash(snap.body) !== snap.hash) return this.journal(sessionId);
    const messages: unknown = JSON.parse(snap.body);
    if (!Array.isArray(messages)) return this.journal(sessionId);
    const tail = this.db.prepare('SELECT message FROM entries WHERE session_id=? AND seq>? ORDER BY seq').all(sessionId, snap.watermark) as { message: string }[];
    return [...messages, ...tail.map(r => JSON.parse(r.message))];
  }
  ingest(appId: string, eventId: string, body: unknown): void {
    this.db.prepare('INSERT INTO ingress(app_id,event_id,body) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(appId, eventId, encode(body));
  }
  prepareAction(token: RunToken, id: string, request: unknown): Effect {
    return this.atomic(() => {
      this.assertRun(token); const body = encode(request);
      const old = this.action(id);
      if (old) {
        if (old.agent_id !== token.agentId || old.request_hash !== hash(body)) throw new Error('Action identity conflict');
        // A prepared intent has not crossed the execution boundary. Rebind only
        // after its previous run is fenced; unknown/executing intents never replay.
        if (old.state === 'prepared') this.db.prepare("UPDATE actions SET run_id=? WHERE id=? AND state='prepared' AND NOT EXISTS(SELECT 1 FROM runs WHERE runs.id=actions.run_id AND runs.state='active')").run(token.id, id);
        return this.action(id)!;
      }
      this.db.prepare("INSERT INTO actions(id,agent_id,run_id,request_hash,request,state) VALUES(?,?,?,?,?,'prepared')").run(id, token.agentId, token.id, hash(body), body);
      return this.action(id)!;
    });
  }
  action(id: string): Effect | undefined { return this.db.prepare('SELECT * FROM actions WHERE id=?').get(id) as Effect | undefined; }
  startAction(token: RunToken, id: string): void {
    this.atomic(() => {
      this.assertRun(token);
      if (this.db.prepare("UPDATE actions SET state='executing' WHERE id=? AND agent_id=? AND run_id=? AND state='prepared'").run(id, token.agentId, token.id).changes !== 1) throw new Error('Action is not executable');
    });
  }
  settleAction(token: RunToken, id: string, state: 'succeeded' | 'failed' | 'unknown', receipt: unknown): void {
    this.atomic(() => {
      this.assertRun(token);
      if (this.db.prepare("UPDATE actions SET state=?,receipt=? WHERE id=? AND agent_id=? AND run_id=? AND state='executing'").run(state, encode(receipt), id, token.agentId, token.id).changes !== 1) throw new Error('Action is not executing');
    });
  }
  queueOutput(agentId: string, id: string, request: unknown): Effect {
    return this.atomic(() => {
      const body = encode(request), old = this.output(id);
      if (old) { if (old.agent_id !== agentId || old.request_hash !== hash(body)) throw new Error('Output identity conflict'); return old; }
      this.db.prepare("INSERT INTO outbox(id,agent_id,request_hash,request,state) VALUES(?,?,?,?,'pending')").run(id, agentId, hash(body), body);
      return this.output(id)!;
    });
  }
  output(id: string): Effect | undefined { return this.db.prepare('SELECT * FROM outbox WHERE id=?').get(id) as Effect | undefined; }
  transitionOutput(id: string, from: string, to: 'sending' | 'sent' | 'unknown' | 'failed' | 'pending' | 'held', receipt?: unknown): void {
    const allowed: Record<string, string[]> = { held: ['pending','failed'], pending: ['sending', 'failed','held'], sending: ['sent', 'unknown', 'failed', 'pending'], unknown: ['sent', 'failed'] };
    if (!allowed[from]?.includes(to)) throw new Error('Invalid output transition');
    if (this.db.prepare('UPDATE outbox SET state=?,receipt=? WHERE id=? AND state=?').run(to, receipt === undefined ? null : encode(receipt), id, from).changes !== 1) throw new Error('Output state conflict');
  }
}
