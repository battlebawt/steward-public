/** Restore a hosted testnet backup into an isolated local database; never touches the service database. */
import { Database } from 'bun:sqlite';
import { readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOffsiteBackupStore, offsiteConfigFromEnv } from '../server/src/operations/offsite-backup';

const stateDir = process.argv.find(arg => arg.startsWith('--state-dir='))?.slice('--state-dir='.length);
if (!stateDir) throw Error('Use --state-dir=/private/state');
const keyPath = join(stateDir, 'backup-key.b64');
const keyInfo = statSync(keyPath);
if (!keyInfo.isFile() || (keyInfo.mode & 0o077) !== 0) throw Error('Backup key file must be 0600');
const key = Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'base64');
if (key.length !== 32) throw Error('Invalid backup key');
const config = offsiteConfigFromEnv(process.env);
if (!config) throw Error('Offsite backup configuration is missing');
if (config.prefix !== 'staging-v1') throw Error('Unexpected testnet backup prefix');
const store = createOffsiteBackupStore(config);
const scratch = await mkdtemp(join(tmpdir(), 'steward-hosted-restore-drill-'));
let result: Record<string, unknown> | undefined;
try {
  const listed = await store.list();
  if (listed.truncated || !listed.files.length) throw Error('No complete hosted backup was found');
  const destination = join(scratch, 'restored.sqlite');
  const latest = listed.files[0]!;
  await store.downloadAndRestore(latest, destination, key, 'staging-v1');
  const db = new Database(destination, { readonly: true });
  try {
    const integrity = db.query('PRAGMA integrity_check').get() as { integrity_check: string };
    if (integrity.integrity_check !== 'ok') throw Error('Restored SQLite integrity check failed');
    const account = db.query('SELECT id,chain_id FROM accounts WHERE lower(address)=lower(?)').get('0xDEE2c04DBb5B1BF90267fd037E5b28315eE00Fd8') as { id: string; chain_id: number } | null;
    if (!account || account.chain_id !== 46630) throw Error('Hosted testnet account missing from restored backup');
    const caregiver = db.query('SELECT g.role,g.scopes_json,g.revoked_at FROM account_grants g JOIN users u ON u.id=g.user_id WHERE g.account_id=? AND lower(u.wallet_address)=lower(?)').get(account.id, '0x1C13ca8F1c8BE9E433f26F6434CF11f5F04d7697') as { role: string; scopes_json: string; revoked_at: string | null } | null;
    const scopes = caregiver ? JSON.parse(caregiver.scopes_json) as string[] : [];
    if (!caregiver || caregiver.role !== 'caregiver' || caregiver.revoked_at || scopes.length !== 2 || !scopes.includes('portfolio.view') || !scopes.includes('family.view')) throw Error('Hosted caregiver grant missing from restored backup');
    result = { status: 'passed', chainId: 46630, backup: latest, offsiteObjectCount: listed.files.length, sqliteIntegrity: 'ok', hostedAccountRestored: true, caregiverApplicationGrantRestored: true, scopes, isolatedDestinationRemoved: true, realFunds: false };
  } finally { db.close(); }
} finally {
  store.destroy();
  await rm(scratch, { recursive: true, force: true });
}
if (result) console.log(JSON.stringify(result));
