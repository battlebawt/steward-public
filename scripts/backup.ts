import { Database } from 'bun:sqlite';
import { backupDatabase, restoreDatabase, verifyBackup } from '../server/src/operations/backup';
const [command,input,output] = process.argv.slice(2);
if (!['backup','restore','verify'].includes(command ?? '') || !input || (command !== 'verify' && !output) || (command === 'verify' && output)) throw new Error('Usage: bun scripts/backup.ts backup|restore INPUT OUTPUT | verify INPUT');
const encoded = process.env.STEWARD_BACKUP_KEY;
if (!encoded) throw new Error('STEWARD_BACKUP_KEY is required (base64, 32 bytes; keep separate from database)');
const key = Buffer.from(encoded, 'base64');
if (key.length !== 32) throw new Error('STEWARD_BACKUP_KEY must decode to 32 bytes');
if (command === 'backup') {
  const db = new Database(input, { readonly: true });
  try { console.log(await backupDatabase(db, output, key, process.env.STEWARD_BACKUP_KEY_VERSION ?? 'v1')); } finally { db.close(); }
} else if (command === 'restore') console.log(await restoreDatabase(input, output, key));
else console.log(await verifyBackup(input, key, process.env.STEWARD_BACKUP_KEY_VERSION ?? 'v1'));
