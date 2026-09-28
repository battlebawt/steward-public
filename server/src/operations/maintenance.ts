import type { Database } from 'bun:sqlite';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { backupDatabase, verifyBackup } from './backup';
import { scanAttachment, type AttachmentScanner } from './attachments';

const MAX_SCAN_BATCH = 100;
const MAX_MANAGED_BACKUP_FILES = 1000;
const MAX_MANAGED_BACKUP_BYTES = 2 * 1024 * 1024 * 1024;
const MARKER = '.steward-backup-directory';
const MANAGED_BACKUP = /^steward-backup-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{16}\.enc$/;

export type QuarantineFailure = { attachmentId: string; code: string };
export type QuarantineDrainResult = {
  requested: number;
  scanned: number;
  released: number;
  rejected: number;
  failed: number;
  remaining: number;
  failures: QuarantineFailure[];
};

export type BackupMaintenanceOptions = {
  directory: string;
  key: Uint8Array;
  keyVersion: string;
  retention?: number;
  deleteExpired?: boolean;
  now?: Date;
};

export type BackupMaintenanceResult = {
  created: string;
  createdBytes: number;
  verifiedBytes: number;
  verified: string[];
  verificationFailures: Array<{ file: string; code: string }>;
  retained: string[];
  deleted: string[];
};

export type MaintenanceStatus = {
  quarantine: { pending: number; failedScans: number; lastAttemptAt: string | null; lastError: string | null };
  backups: { lastAttemptAt: string | null; lastError: string | null };
  offsite: { lastAttemptAt: string | null; lastSuccessAt: string | null; lastError: string | null };
  scannerDefinitions: { lastAttemptAt: string | null; lastSuccessAt: string | null; lastError: string | null };
};

function initMaintenanceEvents(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS ops_maintenance_events(
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, target_id TEXT, status TEXT NOT NULL,
    safe_code TEXT, created_at TEXT NOT NULL
  );`);
}

function safeCode(error: unknown) {
  const code = error instanceof Error ? error.message : '';
  return /^[A-Z][A-Z0-9_]{2,63}$/.test(code) ? code : 'MAINTENANCE_STEP_FAILED';
}

function recordEvent(db: Database, kind: string, targetId: string | null, status: string, code: string | null, at: string) {
  db.query('INSERT INTO ops_maintenance_events(id,kind,target_id,status,safe_code,created_at) VALUES(?,?,?,?,?,?)')
    .run(randomUUID(), kind, targetId, status, code, at);
}

export function recordOffsiteBackupStatus(db: Database, succeeded: boolean, filename: string | null = null, at = new Date().toISOString()) {
  initMaintenanceEvents(db);
  recordEvent(db, 'backup_offsite', filename, succeeded ? 'completed' : 'failed', succeeded ? null : 'OFFSITE_UPLOAD_FAILED', at);
}

/** Opt-in local pruning after a managed filename was uploaded and re-authenticated. */
export async function pruneOffsiteBackedLocalSnapshots(db: Database, options: { directory: string; key: Uint8Array; keyVersion: string; retain: number }) {
  if (!Number.isInteger(options.retain) || options.retain < 1 || options.retain > 999) throw Error('INVALID_BACKUP_RETENTION');
  initMaintenanceEvents(db);
  const root = await ensureManagedBackupDirectory(options.directory, false);
  const files = await managedBackups(root);
  const deleted: string[] = [];
  let notUploaded = 0;
  for (const file of files.slice(options.retain)) {
    const uploaded = db.query("SELECT 1 FROM ops_maintenance_events WHERE kind='backup_offsite' AND target_id=? AND status='completed' LIMIT 1").get(file.name);
    if (!uploaded) { notUploaded++; continue; }
    await verifyBackup(file.path, options.key, options.keyVersion);
    if (!insideRoot(root, file.path)) throw Error('BACKUP_PATH_OUTSIDE_DIRECTORY');
    await unlink(file.path);
    deleted.push(file.name);
  }
  return { deleted, notUploaded, retained: files.length - deleted.length };
}

/** Scans at most a bounded number of oldest quarantine rows. Failures stay queued. */
export async function drainQuarantinedAttachments(
  db: Database,
  key: Uint8Array,
  scanner: AttachmentScanner,
  options: { limit?: number; now?: Date } = {},
): Promise<QuarantineDrainResult> {
  initMaintenanceEvents(db);
  const requestedLimit = options.limit ?? MAX_SCAN_BATCH;
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1) throw new Error('INVALID_SCAN_LIMIT');
  const limit = Math.min(MAX_SCAN_BATCH, requestedLimit);
  const rows = db.query("SELECT a.id FROM attachments a WHERE a.state='quarantined' ORDER BY COALESCE((SELECT max(e.created_at) FROM ops_maintenance_events e WHERE e.kind='attachment_scan' AND e.target_id=a.id),''),a.created_at,a.id LIMIT ?").all(limit) as Array<{ id: string }>;
  const result: QuarantineDrainResult = { requested: rows.length, scanned: 0, released: 0, rejected: 0, failed: 0, remaining: 0, failures: [] };
  const at = (options.now ?? new Date()).toISOString();
  for (const row of rows) {
    try {
      const outcome = await scanAttachment(db, key, row.id, scanner);
      result.scanned++;
      if (outcome.state === 'released') result.released++; else result.rejected++;
      recordEvent(db, 'attachment_scan', row.id, outcome.state, null, at);
    } catch (error) {
      const code = safeCode(error);
      result.failed++;
      result.failures.push({ attachmentId: row.id, code });
      recordEvent(db, 'attachment_scan', row.id, 'failed', code, at);
    }
  }
  result.remaining = (db.query("SELECT count(*) AS count FROM attachments WHERE state='quarantined'").get() as { count: number }).count;
  return result;
}

async function ensureManagedBackupDirectory(directory: string, create = true) {
  const root = resolve(directory);
  if (root === resolve(sep) || root === resolve('.') || root === resolve('..')) throw new Error('BACKUP_DIRECTORY_UNSAFE');
  if(create)await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await stat(root);
  if (!info.isDirectory()) throw new Error('BACKUP_DIRECTORY_REQUIRED');
  const marker = join(root, MARKER);
  const expected = 'steward-encrypted-backup-directory-v1\n';
  try {
    if (await readFile(marker, 'utf8') !== expected) throw new Error('BACKUP_DIRECTORY_MARKER_INVALID');
  } catch (error) {
    if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await writeFile(marker, expected, { flag: 'wx', mode: 0o600 });
  }
  return root;
}

function insideRoot(root: string, candidate: string) {
  const path = resolve(candidate);
  return path !== root && path.startsWith(`${root}${sep}`);
}

async function managedBackups(root: string) {
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.filter(entry => MANAGED_BACKUP.test(entry.name)).length > MAX_MANAGED_BACKUP_FILES) throw new Error('BACKUP_DIRECTORY_FILE_LIMIT');
  const files: Array<{ name: string; path: string; mtimeMs: number; size: number }> = [];
  let totalBytes = 0;
  for (const entry of entries) {
    if (!MANAGED_BACKUP.test(entry.name)) continue;
    const path = join(root, entry.name);
    if (!insideRoot(root, path) || !entry.isFile()) continue;
    const details = await stat(path);
    totalBytes += details.size;
    if (totalBytes > MAX_MANAGED_BACKUP_BYTES) throw new Error('BACKUP_DIRECTORY_SIZE_LIMIT');
    files.push({ name: entry.name, path, mtimeMs: details.mtimeMs, size: details.size });
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
}

function backupName(now: Date) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `steward-backup-${stamp}-${randomBytes(8).toString('hex')}.enc`;
}

/** Creates and authenticates a local backup, with retention deletion opt-in and path scoped. */
export async function maintainEncryptedBackups(db: Database, options: BackupMaintenanceOptions): Promise<BackupMaintenanceResult> {
  initMaintenanceEvents(db);
  if (options.key.length !== 32) throw new Error('INVALID_BACKUP_KEY');
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(options.keyVersion)) throw new Error('INVALID_BACKUP_KEY');
  if (options.retention !== undefined && (!Number.isInteger(options.retention) || options.retention < 1 || options.retention > 1000)) throw new Error('INVALID_BACKUP_RETENTION');
  if (options.deleteExpired && options.retention === undefined) throw new Error('RETENTION_REQUIRED_FOR_DELETE');
  try {
    const root = await ensureManagedBackupDirectory(options.directory);
    // Enforce the directory limits before writing, so a full directory cannot keep growing.
    const existing = await managedBackups(root);
    if (existing.length >= MAX_MANAGED_BACKUP_FILES) throw Error('BACKUP_DIRECTORY_FILE_LIMIT');
    const remaining = MAX_MANAGED_BACKUP_BYTES - existing.reduce((sum, file) => sum + file.size, 0);
    const output = join(root, backupName(options.now ?? new Date()));
    const createdRecord = await backupDatabase(db, output, options.key, options.keyVersion, remaining);
    const files = await managedBackups(root);
    const verified: string[] = [];
    let verifiedBytes = 0;
    const verificationFailures: Array<{ file: string; code: string }> = [];
    for (const file of files) {
      try {
        await verifyBackup(file.path, options.key, options.keyVersion);
        verified.push(file.name);
        verifiedBytes += file.size;
      } catch (error) {
        verificationFailures.push({ file: file.name, code: safeCode(error) });
      }
    }
    const keep = options.retention ?? files.length;
    const retained = files.filter(file => verified.includes(file.name)).slice(0, keep).map(file => file.name);
    const deleted: string[] = [];
    if (options.deleteExpired && verificationFailures.length === 0) {
      for (const file of files.slice(keep)) {
        // The filename was matched above and the marker was authenticated; no caller path is accepted here.
        if (!insideRoot(root, file.path)) throw new Error('BACKUP_PATH_OUTSIDE_DIRECTORY');
        await unlink(file.path);
        deleted.push(file.name);
      }
    }
    const at = (options.now ?? new Date()).toISOString();
    recordEvent(db, 'backup_maintenance', null, verificationFailures.length ? 'failed' : 'completed', verificationFailures[0]?.code ?? null, at);
    return { created: basename(output), createdBytes: createdRecord.bytes, verifiedBytes, verified, verificationFailures, retained, deleted };
  } catch (error) {
    recordEvent(db, 'backup_maintenance', null, 'failed', safeCode(error), (options.now ?? new Date()).toISOString());
    throw error;
  }
}

/** Verifies existing tool-created snapshots without creating or deleting anything. */
export async function verifyManagedBackups(directory: string, key: Uint8Array, keyVersion?: string) {
  const root = await ensureManagedBackupDirectory(directory, false);
  const files = await managedBackups(root);
  const verified: string[] = [];
  const failures: Array<{ file: string; code: string }> = [];
  for (const file of files) {
    try { await verifyBackup(file.path, key, keyVersion); verified.push(file.name); }
    catch (error) { failures.push({ file: file.name, code: safeCode(error) }); }
  }
  return { directory: root, files: files.map(file => file.name), verified, failures };
}

/** Redacted operator health summary; target identifiers are intentionally excluded. */
export function getMaintenanceStatus(db: Database): MaintenanceStatus {
  const pending = (db.query("SELECT count(*) AS count FROM attachments WHERE state='quarantined'").get() as { count: number }).count;
  const table = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ops_maintenance_events'").get();
  const absent = { lastAttemptAt: null, lastSuccessAt: null, lastError: null };
  if (!table) return { quarantine: { pending, failedScans: 0, lastAttemptAt: null, lastError: null }, backups: { lastAttemptAt: null, lastError: null }, offsite: absent, scannerDefinitions: absent };
  const recent = (kind: string) => {
    const latest = db.query('SELECT status,safe_code,created_at FROM ops_maintenance_events WHERE kind=? ORDER BY rowid DESC LIMIT 1').get(kind) as { status: string; safe_code: string | null; created_at: string } | null;
    const success = db.query("SELECT created_at FROM ops_maintenance_events WHERE kind=? AND status='completed' ORDER BY rowid DESC LIMIT 1").get(kind) as { created_at: string } | null;
    return { lastAttemptAt: latest?.created_at ?? null, lastSuccessAt: success?.created_at ?? null, lastError: latest?.status === 'failed' ? latest.safe_code : null };
  };
  const failedScans = (db.query("SELECT count(*) AS count FROM ops_maintenance_events WHERE kind='attachment_scan' AND status='failed'").get() as { count: number }).count;
  const scan = db.query("SELECT status,safe_code,created_at FROM ops_maintenance_events WHERE kind='attachment_scan' ORDER BY created_at DESC,id DESC LIMIT 1").get() as { status: string; safe_code: string | null; created_at: string } | null;
  const scanFailure = db.query("SELECT safe_code FROM ops_maintenance_events WHERE kind='attachment_scan' AND status='failed' ORDER BY created_at DESC,id DESC LIMIT 1").get() as { safe_code: string | null } | null;
  const backup = db.query("SELECT status,safe_code,created_at FROM ops_maintenance_events WHERE kind='backup_maintenance' ORDER BY created_at DESC,id DESC LIMIT 1").get() as { status: string; safe_code: string | null; created_at: string } | null;
  const backupFailure = db.query("SELECT safe_code FROM ops_maintenance_events WHERE kind='backup_maintenance' AND status='failed' ORDER BY created_at DESC,id DESC LIMIT 1").get() as { safe_code: string | null } | null;
  return {
    quarantine: { pending, failedScans, lastAttemptAt: scan?.created_at ?? null, lastError: scanFailure?.safe_code ?? null },
    backups: { lastAttemptAt: backup?.created_at ?? null, lastError: backupFailure?.safe_code ?? null },
    offsite: recent('backup_offsite'),
    scannerDefinitions: recent('scanner_definitions'),
  };
}

/** Aggregate operator view; no account identifiers, recipient addresses or job payloads. */
export function getOperationalStatus(db: Database) {
  const maintenance = getMaintenanceStatus(db);
  const outbox = Object.fromEntries(['pending', 'leased', 'accepted', 'delivered', 'dead'].map(status => [status,
    (db.query('SELECT count(*) AS count FROM ops_outbox WHERE status=?').get(status) as { count: number }).count]));
  const oldestDue = db.query("SELECT min(available_at) AS at FROM ops_outbox WHERE status='pending'").get() as { at: number | null };
  const lastDeliveryFailure = db.query("SELECT safe_code FROM ops_delivery_attempts WHERE safe_code IS NOT NULL ORDER BY at DESC,id DESC LIMIT 1").get() as { safe_code: string } | null;
  const cursors = db.query('SELECT chain_id,next_block,last_success FROM ops_index_cursors ORDER BY chain_id').all() as Array<{ chain_id: number; next_block: number; last_success: number | null }>;
  return { maintenance, outbox, oldestPendingAt: oldestDue.at, lastDeliveryFailure: lastDeliveryFailure?.safe_code ?? null,
    indexer: cursors.map(cursor => ({ chainId: cursor.chain_id, nextBlock: cursor.next_block, lastSuccessAt: cursor.last_success })) };
}
