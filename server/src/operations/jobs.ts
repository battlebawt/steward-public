import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
export type Job = { id: string; account_id: string; kind: string; payload: string; attempts: number; lease_owner: string };
export function initOperations(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS ops_outbox (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, kind TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE,
    payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','leased','accepted','delivered','dead')),
    attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL, lease_until INTEGER, lease_owner TEXT,
    provider_id TEXT, last_error TEXT, created_at INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS ops_due ON ops_outbox(status,available_at);
  CREATE TABLE IF NOT EXISTS ops_delivery_attempts(id INTEGER PRIMARY KEY, job_id TEXT NOT NULL REFERENCES ops_outbox(id),
    at INTEGER NOT NULL, status TEXT NOT NULL, safe_code TEXT);
  CREATE TABLE IF NOT EXISTS ops_in_app_notifications(id TEXT PRIMARY KEY, account_id TEXT NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS ops_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
}
/** Call inside the business transaction for atomic event + notification enqueue. Payload holds opaque IDs only. */
export function enqueue(db: Database, input: { accountId: string; kind: string; dedupeKey: string; payload: { resourceId: string } }, now = Date.now()) {
  const id = randomUUID();
  db.query('INSERT OR IGNORE INTO ops_outbox(id,account_id,kind,dedupe_key,payload,available_at,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, input.accountId, input.kind, input.dedupeKey, JSON.stringify(input.payload), now, now);
  return (db.query('SELECT id FROM ops_outbox WHERE dedupe_key=?').get(input.dedupeKey) as { id: string }).id;
}
export function claim(db: Database, owner: string, now = Date.now(), leaseMs = 30_000, maxAttempts = 5): Job | null {
  return db.transaction(() => {
    db.query("UPDATE ops_outbox SET status='dead',last_error='LEASE_EXHAUSTED',lease_owner=NULL,lease_until=NULL WHERE status='leased' AND lease_until<=? AND attempts>=?").run(now, maxAttempts);
    db.query("UPDATE ops_outbox SET status='pending',lease_owner=NULL,lease_until=NULL WHERE status='leased' AND lease_until<=?").run(now);
    const row = db.query("SELECT id FROM ops_outbox WHERE status='pending' AND available_at<=? AND attempts<? ORDER BY available_at,id LIMIT 1").get(now, maxAttempts) as { id: string } | null;
    if (!row) return null;
    db.query("UPDATE ops_outbox SET status='leased',attempts=attempts+1,lease_owner=?,lease_until=? WHERE id=?").run(owner, now + leaseMs, row.id);
    return db.query('SELECT * FROM ops_outbox WHERE id=?').get(row.id) as Job;
  }).immediate();
}
export type DeliveryResult = { status: 'accepted' | 'delivered'; providerId: string };
export type DeliveryChannel = (job: Job) => Promise<DeliveryResult>;
export async function runOne(db: Database, owner: string, deliver: DeliveryChannel, now = Date.now(), maxAttempts = 5) {
  const job = claim(db, owner, now, 30_000, maxAttempts);
  if (!job) return false;
  try {
    const result = await deliver(job);
    db.transaction(() => {
      const change = db.query('UPDATE ops_outbox SET status=?,provider_id=?,lease_until=NULL,lease_owner=NULL WHERE id=? AND lease_owner=? AND status=\'leased\'')
        .run(result.status, result.providerId, job.id, owner);
      if (change.changes) db.query('INSERT INTO ops_delivery_attempts(job_id,at,status) VALUES (?,?,?)').run(job.id, now, result.status);
    })();
  } catch {
    db.transaction(() => {
      const state = job.attempts >= maxAttempts ? 'dead' : 'pending';
      const change = db.query("UPDATE ops_outbox SET status=?,available_at=?,last_error='DELIVERY_FAILED',lease_owner=NULL,lease_until=NULL WHERE id=? AND lease_owner=? AND status='leased'")
        .run(state, now + Math.min(3_600_000, 1000 * 2 ** job.attempts), job.id, owner);
      if (change.changes) db.query('INSERT INTO ops_delivery_attempts(job_id,at,status,safe_code) VALUES (?,?,?,?)').run(job.id, now, state, 'DELIVERY_FAILED');
    })();
  }
  return true;
}
export function inAppChannel(db: Database): DeliveryChannel {
  return async job => {
    db.query('INSERT OR IGNORE INTO ops_in_app_notifications(id,account_id,kind,created_at) VALUES (?,?,?,?)').run(job.id, job.account_id, job.kind, Date.now());
    return { status: 'delivered', providerId: job.id };
  };
}
/** Configured adapter must pass job.id as provider idempotency key; acceptance is not delivery. */
export function emailChannel(send: (input: { accountId: string; idempotencyKey: string; subject: string; text: string }) => Promise<{ id: string }>): DeliveryChannel {
  return async job => {
    const result = await send({ accountId: job.account_id, idempotencyKey: job.id, subject: 'Steward account update', text: 'An account update is available. Open Steward to review it.' });
    return { status: 'accepted', providerId: result.id };
  };
}
/** Only a verified provider receipt/webhook caller may invoke this, never a browser request. */
export function recordDelivered(db: Database, providerId: string, at = Date.now()) {
  db.transaction(()=>{
    db.query("INSERT INTO ops_delivery_attempts(job_id,at,status) SELECT id,?,'delivered' FROM ops_outbox WHERE provider_id=? AND status='accepted'").run(at,providerId);
    db.query("UPDATE ops_outbox SET status='delivered' WHERE provider_id=? AND status='accepted'").run(providerId);
  })();
}
/** Permanent provider failures require operator attention; never resend a bounced or complained message automatically. */
export function recordDeliveryFailure(db: Database, providerId: string, at = Date.now()) {
  db.transaction(()=>{
    db.query("INSERT INTO ops_delivery_attempts(job_id,at,status,safe_code) SELECT id,?,'dead','PROVIDER_DELIVERY_FAILED' FROM ops_outbox WHERE provider_id=? AND status IN ('accepted','delivered')").run(at,providerId);
    db.query("UPDATE ops_outbox SET status='dead',last_error='PROVIDER_DELIVERY_FAILED' WHERE provider_id=? AND status IN ('accepted','delivered')").run(providerId);
  })();
}
