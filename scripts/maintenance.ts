import { Database } from 'bun:sqlite';
import { decodeServiceKey } from '../server/src/crypto';
import { clamAvScanner } from '../server/src/operations/attachments';
import { drainQuarantinedAttachments, getOperationalStatus, maintainEncryptedBackups, verifyManagedBackups } from '../server/src/operations/maintenance';

function backupKey() {
  const encoded = process.env.STEWARD_BACKUP_KEY;
  if (!encoded) throw new Error('STEWARD_BACKUP_KEY is required (base64, 32 bytes; keep separate from service key)');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error('STEWARD_BACKUP_KEY must decode to 32 bytes');
  return key;
}

function safeCode(error: unknown) {
  const code = error instanceof Error ? error.message : '';
  return /^[A-Z][A-Z0-9_]{2,63}$/.test(code) ? code : 'MAINTENANCE_FAILED';
}

function usage(): never {
  throw new Error('Usage: bun scripts/maintenance.ts status DATABASE | scan DATABASE [LIMIT] | backup DATABASE BACKUP_DIRECTORY [--retain N] [--delete] | verify BACKUP_DIRECTORY');
}

export async function runMaintenance(argv = process.argv.slice(2)) {
  const [command, first, second, ...rest] = argv;
  if (!command) usage();
  if (command === 'status') {
    if (!first || second || rest.length) usage();
    const db = new Database(first, { readonly: true });
    try { return getOperationalStatus(db); } finally { db.close(); }
  }
  if (command === 'scan') {
    if (!first || rest.length) usage();
    const limit = second === undefined ? undefined : Number(second);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error('INVALID_SCAN_LIMIT');
    const db = new Database(first);
    try {
      const key = decodeServiceKey(process.env.STEWARD_SERVICE_KEY, false);
      return await drainQuarantinedAttachments(db, key, clamAvScanner(process.env.STEWARD_CLAMSCAN_PATH), { limit });
    } finally { db.close(); }
  }
  if (command === 'backup') {
    if (!first || !second) usage();
    let retention: number | undefined;
    let deleteExpired = false;
    for (let index = 0; index < rest.length; index++) {
      if (rest[index] === '--delete') { deleteExpired = true; continue; }
      if (rest[index] === '--retain') {
        const value = Number(rest[++index]);
        if (!Number.isInteger(value) || value < 1) throw new Error('INVALID_BACKUP_RETENTION');
        retention = value;
        continue;
      }
      usage();
    }
    const db = new Database(first);
    try {
      return await maintainEncryptedBackups(db, { directory: second, key: backupKey(), keyVersion: process.env.STEWARD_BACKUP_KEY_VERSION ?? 'v1', retention, deleteExpired });
    } finally { db.close(); }
  }
  if (command === 'verify') {
    if (!first || second || rest.length) usage();
    return await verifyManagedBackups(first, backupKey(), process.env.STEWARD_BACKUP_KEY_VERSION ?? 'v1');
  }
  usage();
}

if (import.meta.main) {
  try {
    const result = await runMaintenance();
    console.log(JSON.stringify(result));
    const failed = typeof result === 'object' && result !== null && (
      ('failed' in result && Number(result.failed) > 0) ||
      ('verificationFailures' in result && Array.isArray(result.verificationFailures) && result.verificationFailures.length > 0) ||
      ('failures' in result && Array.isArray(result.failures) && result.failures.length > 0)
    );
    if (failed) process.exitCode = 2;
  }
  catch (error) { console.error(safeCode(error)); process.exitCode = 1; }
}
