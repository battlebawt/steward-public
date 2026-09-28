import { Database } from 'bun:sqlite'

export type StewardDatabase = Database

export const migrations = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, wallet_address TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS credentials (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, public_key TEXT, expires_at TEXT, revoked_at TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS auth_nonces (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE SET NULL, address TEXT NOT NULL, chain_id INTEGER NOT NULL, domain TEXT NOT NULL, nonce_hash TEXT NOT NULL UNIQUE, message TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS auth_nonces_active_idx ON auth_nonces(address, chain_id, expires_at, consumed_at)`,
  `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, secret_hash TEXT NOT NULL UNIQUE, address TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS sessions_active_idx ON sessions(secret_hash, expires_at, revoked_at)`,
  `CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, chain_id INTEGER NOT NULL, address TEXT NOT NULL, parent_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, policy_version TEXT NOT NULL DEFAULT '1', security_epoch TEXT NOT NULL DEFAULT '1', snapshot_block TEXT NOT NULL DEFAULT '0', snapshot_hash TEXT, index_freshness TEXT NOT NULL DEFAULT 'fresh', created_at TEXT NOT NULL, UNIQUE(chain_id,address))`,
  `CREATE TABLE IF NOT EXISTS account_versions (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, implementation TEXT NOT NULL, manifest_version TEXT NOT NULL, provenance_block TEXT NOT NULL, provenance_hash TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS policy_snapshots (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, version TEXT NOT NULL, policy_json TEXT NOT NULL, effective_at TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(account_id,version))`,
  `CREATE TABLE IF NOT EXISTS delegate_snapshots (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, delegate_address TEXT NOT NULL, role TEXT NOT NULL, scopes_json TEXT NOT NULL, expires_at TEXT, revoked_at TEXT, created_at TEXT NOT NULL, UNIQUE(account_id,delegate_address))`,
  `CREATE TABLE IF NOT EXISTS account_grants (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL, scopes_json TEXT NOT NULL, expires_at TEXT, revoked_at TEXT, created_at TEXT NOT NULL, UNIQUE(account_id,user_id))`,
  `CREATE INDEX IF NOT EXISTS account_grants_lookup_idx ON account_grants(account_id,user_id,revoked_at,expires_at)`,
  `CREATE TABLE IF NOT EXISTS invitations (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, secret_hash TEXT NOT NULL UNIQUE, intended_address TEXT, intended_email_hash TEXT, role TEXT NOT NULL, scopes_json TEXT NOT NULL, expires_at TEXT NOT NULL, accepted_at TEXT, accepted_by_user_id TEXT REFERENCES users(id), created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, provider TEXT NOT NULL, chain_id INTEGER NOT NULL, address TEXT NOT NULL, symbol TEXT NOT NULL, name TEXT NOT NULL, decimals INTEGER NOT NULL, legal_instrument_type TEXT NOT NULL, source_terms_version TEXT NOT NULL, capabilities_json TEXT NOT NULL, admission TEXT NOT NULL, admission_reason TEXT, metadata_json TEXT, UNIQUE(chain_id,address))`,
  `CREATE TABLE IF NOT EXISTS holdings_snapshots (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT, balance_raw TEXT NOT NULL, observed_block TEXT NOT NULL, observed_at TEXT NOT NULL, UNIQUE(account_id,asset_id,observed_block))`,
  `CREATE TABLE IF NOT EXISTS intents (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, action_hash TEXT NOT NULL UNIQUE, actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, actor_address TEXT NOT NULL, action_json TEXT NOT NULL, state TEXT NOT NULL, required_approvals INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, cancelled_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS intents_account_idx ON intents(account_id,created_at,state)`,
  `CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, intent_id TEXT NOT NULL REFERENCES intents(id) ON DELETE CASCADE, signer_address TEXT NOT NULL, signature TEXT NOT NULL, signature_type TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(intent_id,signer_address))`,
  `CREATE TABLE IF NOT EXISTS transactions (id TEXT PRIMARY KEY, intent_id TEXT NOT NULL REFERENCES intents(id) ON DELETE CASCADE, tx_hash TEXT NOT NULL, chain_id INTEGER NOT NULL, state TEXT NOT NULL, sender_address TEXT, block_number TEXT, block_hash TEXT, receipt_json TEXT, observed_at TEXT NOT NULL, UNIQUE(chain_id,tx_hash))`,
  `CREATE TABLE IF NOT EXISTS idempotency_records (id TEXT PRIMARY KEY, actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE, method TEXT NOT NULL, request_key TEXT NOT NULL, body_hash TEXT NOT NULL, response_status INTEGER NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(actor_user_id,account_id,method,request_key))`,
  `CREATE TABLE IF NOT EXISTS chain_blocks (chain_id INTEGER NOT NULL, number TEXT NOT NULL, hash TEXT NOT NULL, parent_hash TEXT NOT NULL, finality TEXT NOT NULL, observed_at TEXT NOT NULL, PRIMARY KEY(chain_id,number))`,
  `CREATE TABLE IF NOT EXISTS chain_events (chain_id INTEGER NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, block_number TEXT NOT NULL, block_hash TEXT NOT NULL, event_name TEXT NOT NULL, payload_json TEXT NOT NULL, canonical INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(chain_id,tx_hash,log_index))`,
  `CREATE TABLE IF NOT EXISTS index_cursors (chain_id INTEGER PRIMARY KEY, next_block TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS expenses (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, intent_id TEXT REFERENCES intents(id) ON DELETE SET NULL, amount_raw TEXT NOT NULL, token_address TEXT NOT NULL, purpose_ciphertext TEXT, state TEXT NOT NULL, created_by_user_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, storage_key TEXT NOT NULL UNIQUE, filename_ciphertext TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, state TEXT NOT NULL, created_by_user_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS document_grants (id TEXT PRIMARY KEY, attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, scope TEXT NOT NULL, expires_at TEXT, revoked_at TEXT, created_at TEXT NOT NULL, UNIQUE(attachment_id,user_id))`,
  `CREATE TABLE IF NOT EXISTS continuity_cases (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, type TEXT NOT NULL, state TEXT NOT NULL, successor_address TEXT, plan_version TEXT NOT NULL, evidence_ref_ciphertext TEXT, chain_case_id TEXT, execution_tx_hash TEXT, deadline TEXT, created_by_user_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS case_events (id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES continuity_cases(id) ON DELETE CASCADE, from_state TEXT, to_state TEXT NOT NULL, actor_user_id TEXT NOT NULL REFERENCES users(id), payload_ciphertext TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, topic TEXT NOT NULL, payload_json TEXT NOT NULL, available_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, completed_at TEXT, dead_lettered_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS delivery_attempts (id TEXT PRIMARY KEY, outbox_id TEXT NOT NULL REFERENCES outbox(id) ON DELETE CASCADE, provider TEXT NOT NULL, status TEXT NOT NULL, response_code INTEGER, attempted_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS job_leases (name TEXT PRIMARY KEY, holder TEXT NOT NULL, leased_until TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS audit_events (id TEXT PRIMARY KEY, account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL, actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL, event_type TEXT NOT NULL, target_type TEXT, target_id TEXT, metadata_json TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS audit_events_account_idx ON audit_events(account_id,created_at)`,
  `ALTER TABLE invitations ADD COLUMN security_epoch TEXT NOT NULL DEFAULT '0'`,
  `ALTER TABLE continuity_cases ADD COLUMN request_tx_hash TEXT`,
  `CREATE UNIQUE INDEX continuity_chain_case_unique ON continuity_cases(account_id,type,chain_case_id) WHERE chain_case_id IS NOT NULL`,
  `CREATE UNIQUE INDEX continuity_execution_unique ON continuity_cases(account_id,execution_tx_hash) WHERE execution_tx_hash IS NOT NULL`,
  `ALTER TABLE continuity_cases ADD COLUMN plan_hash TEXT`,
  `ALTER TABLE continuity_cases ADD COLUMN evidence_hash TEXT`,
  `ALTER TABLE continuity_cases ADD COLUMN security_epoch TEXT`,
  `ALTER TABLE account_versions ADD COLUMN account_version TEXT NOT NULL DEFAULT 'v1'`,
  `ALTER TABLE account_versions ADD COLUMN factory_address TEXT`,
  `ALTER TABLE account_versions ADD COLUMN cow_module TEXT`,
  `CREATE TABLE IF NOT EXISTS v2_orders (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, digest TEXT NOT NULL, actor_user_id TEXT NOT NULL REFERENCES users(id), actor_address TEXT NOT NULL, order_json TEXT NOT NULL, action_json TEXT NOT NULL, action_hash TEXT NOT NULL, security_epoch TEXT NOT NULL, nonce TEXT NOT NULL, prepared_data TEXT, close_prepared_data TEXT, open_tx_hash TEXT, close_tx_hash TEXT, close_operation TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(account_id,digest), UNIQUE(account_id,actor_address,security_epoch,nonce))`,
  `CREATE TABLE IF NOT EXISTS v2_order_approvals (id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES v2_orders(id) ON DELETE CASCADE, signer_address TEXT NOT NULL, signature TEXT NOT NULL, signature_type TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(order_id,signer_address))`,
  `CREATE TABLE IF NOT EXISTS v2_order_attempts (id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES v2_orders(id) ON DELETE CASCADE, operation TEXT NOT NULL CHECK(operation IN ('open','cancel','reconcile')), tx_hash TEXT NOT NULL UNIQUE, outcome TEXT NOT NULL CHECK(outcome IN ('confirmed','reverted')), observed_at TEXT NOT NULL)`,
]

export function migrate(db: StewardDatabase) {
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  try { db.exec('PRAGMA journal_mode = WAL') } catch { /* in-memory SQLite does not support WAL */ }
  db.exec('BEGIN IMMEDIATE')
  try {
    for (let i = 0; i < migrations.length; i++) {
      if (i === 0) { db.exec(migrations[i]); continue }
      const existing = db.query('SELECT 1 FROM schema_migrations WHERE version = ?').get(i) as { 1: number } | null
      if (!existing) { db.exec(migrations[i]); db.query('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)').run(i, new Date().toISOString()) }
    }
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
  return db
}

export function createDatabase(filename = ':memory:') { return migrate(new Database(filename)) }
