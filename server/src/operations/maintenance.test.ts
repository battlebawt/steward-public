import { test, expect } from 'bun:test';
import { chmod, mkdtemp, readdir, rm, stat, truncate, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { createDatabase } from '../db';
import { encryptRecord } from '../crypto';
import { clamAvScanner } from './attachments';
import {backupDatabase} from './backup';
import { getMaintenanceStatus, maintainEncryptedBackups, drainQuarantinedAttachments, pruneOffsiteBackedLocalSnapshots, recordOffsiteBackupStatus, verifyManagedBackups } from './maintenance';

async function fixtureAttachment(db: ReturnType<typeof createDatabase>, id: string, key: Uint8Array, plain: string) {
  const at = new Date().toISOString();
  const bytes = new TextEncoder().encode(plain);
  db.query('INSERT OR IGNORE INTO users(id,wallet_address,created_at) VALUES(?,?,?)').run('maintenance-user', '0x0000000000000000000000000000000000000001', at);
  db.query('INSERT OR IGNORE INTO accounts(id,chain_id,address,parent_user_id,created_at) VALUES (?,?,?,?,?)').run('maintenance-account', 31337, '0x0000000000000000000000000000000000000002', 'maintenance-user', at);
  db.query('INSERT INTO attachments(id,account_id,storage_key,filename_ciphertext,mime_type,size_bytes,sha256,state,created_by_user_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, 'maintenance-account', JSON.stringify(await encryptRecord(bytes, key, 'v1', id)), JSON.stringify(await encryptRecord(`${id}.pdf`, key, 'v1', `${id}:name`)), 'application/pdf', bytes.length, createHash('sha256').update(bytes).digest('hex'), 'quarantined', 'maintenance-user', at);
}

test('bounded quarantine drain keeps stale scanner failures visible and queued', async () => {
  const db = createDatabase(':memory:');
  const key = randomBytes(32);
  try {
    await fixtureAttachment(db, 'a-stale', key, 'stale fixture');
    await fixtureAttachment(db, 'b-clean', key, 'clean fixture');
    const first = await drainQuarantinedAttachments(db, key, async bytes => {
      if (new TextDecoder().decode(bytes).startsWith('stale')) throw new Error('SCANNER_DEFINITIONS_STALE');
      return { clean: true, engine: 'mock-fixture' };
    }, { limit: 1 });
    expect(first).toMatchObject({ requested: 1, scanned: 0, failed: 1, remaining: 2 });
    expect(first.failures).toEqual([{ attachmentId: 'a-stale', code: 'SCANNER_DEFINITIONS_STALE' }]);
    const second = await drainQuarantinedAttachments(db, key, async bytes => {
      if (new TextDecoder().decode(bytes).startsWith('stale')) throw new Error('SCANNER_DEFINITIONS_STALE');
      return { clean: true, engine: 'mock-fixture' };
    });
    expect(second).toMatchObject({ requested: 2, scanned: 1, released: 1, failed: 1, remaining: 1 });
    expect(db.query("SELECT state FROM attachments WHERE id='a-stale'").get()).toEqual({ state: 'quarantined' });
    expect(db.query("SELECT status,safe_code FROM ops_maintenance_events WHERE target_id='a-stale' ORDER BY created_at LIMIT 1").get()).toEqual({ status: 'failed', safe_code: 'SCANNER_DEFINITIONS_STALE' });
    expect(getMaintenanceStatus(db)).toMatchObject({ quarantine: { pending: 1, failedScans: 2, lastError: 'SCANNER_DEFINITIONS_STALE' } });
    expect(JSON.stringify(getMaintenanceStatus(db))).not.toContain('a-stale');
    await fixtureAttachment(db,'c-next',key,'next fixture');
    const next=await drainQuarantinedAttachments(db,key,async()=>({clean:true,engine:'mock-fixture'}),{limit:1});
    expect(next.released).toBe(1);
    expect(db.query("SELECT state FROM attachments WHERE id='c-next'").get()).toEqual({state:'released'});
    expect(db.query("SELECT state FROM attachments WHERE id='a-stale'").get()).toEqual({state:'quarantined'});
  } finally { db.close(); }
});

test('local mock scanner executable is bounded and stale definitions never release a file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'steward-scanner-fixture-'));
  const script = join(dir, 'mock-clamscan');
  const db = createDatabase(':memory:');
  const key = randomBytes(32);
  try {
    await fixtureAttachment(db, 'fixture', key, 'scanner fixture');
    await writeFile(script, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "ClamAV 1.4.0/2020-01-01"; exit 0; fi\ncat >/dev/null\nexit 0\n');
    await chmod(script, 0o700);
    const result = await drainQuarantinedAttachments(db, key, clamAvScanner(script), { limit: 1 });
    expect(result).toMatchObject({ requested: 1, scanned: 0, failed: 1, remaining: 1 });
    expect(result.failures[0]?.code).toBe('SCANNER_DEFINITIONS_STALE');
    expect(db.query("SELECT state FROM attachments WHERE id='fixture'").get()).toEqual({ state: 'quarantined' });
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('encrypted backup maintenance verifies keys and deletes only explicit managed retention files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'steward-maintenance-backups-'));
  const db = createDatabase(':memory:');
  const key = randomBytes(32);
  try {
    await writeFile(join(dir, 'operator-note.txt'), 'must remain');
    const first = await maintainEncryptedBackups(db, { directory: dir, key, keyVersion: 'fixture', now: new Date('2026-09-20T00:00:00Z') });
    const second = await maintainEncryptedBackups(db, { directory: dir, key, keyVersion: 'fixture', now: new Date('2026-09-21T00:00:00Z') });
    expect(first.verificationFailures).toEqual([]);
    expect(second.verified.length).toBe(2);
    expect(first.createdBytes).toBeGreaterThan(0);
    expect(second.verifiedBytes).toBe(first.createdBytes + second.createdBytes);
    expect((await verifyManagedBackups(dir, randomBytes(32), 'fixture')).failures[0]?.code).toBe('BACKUP_AUTH_FAILED');
    expect((await verifyManagedBackups(dir, key, 'fixture')).failures).toEqual([]);
    const retained = await maintainEncryptedBackups(db, { directory: dir, key, keyVersion: 'fixture', retention: 1, deleteExpired: true, now: new Date('2026-09-22T00:00:00Z') });
    expect(retained.deleted.length).toBe(2);
    expect(retained.retained.length).toBe(1);
    expect(await Bun.file(join(dir, 'operator-note.txt')).text()).toBe('must remain');
    expect((await verifyManagedBackups(dir, key, 'fixture')).files.length).toBe(1);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

 test('backup publication refuses to overwrite an existing retained snapshot',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'steward-backup-existing-')),db=createDatabase(':memory:');
 try{const path=join(directory,'existing.enc');await writeFile(path,'retained-original');await expect(backupDatabase(db,path,randomBytes(32),'fixture')).rejects.toThrow();expect(await Bun.file(path).text()).toBe('retained-original');}finally{db.close();await rm(directory,{recursive:true,force:true});}
 });

test('local pruning keeps unuploaded snapshots and refuses deletion when verification fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'steward-offsite-prune-'));
  const db = createDatabase(':memory:');
  const key = randomBytes(32);
  try {
    const dates = ['2026-09-20T00:00:00Z', '2026-09-21T00:00:00Z', '2026-09-22T00:00:00Z'];
    const files: string[] = [];
    for (const date of dates) {
      const snapshot = await maintainEncryptedBackups(db, { directory, key, keyVersion: 'fixture', now: new Date(date) });
      files.push(snapshot.created);
      await utimes(join(directory, snapshot.created), new Date(date), new Date(date));
    }
    recordOffsiteBackupStatus(db, true, files[0]!);
    recordOffsiteBackupStatus(db, false, files[1]!);
    recordOffsiteBackupStatus(db, true, files[2]!);
    const firstPrune = await pruneOffsiteBackedLocalSnapshots(db, { directory, key, keyVersion: 'fixture', retain: 1 });
    expect(firstPrune).toMatchObject({ deleted: [files[0]], notUploaded: 1, retained: 2 });
    expect(await Bun.file(join(directory, files[0]!)).exists()).toBe(false);
    expect(await Bun.file(join(directory, files[1]!)).exists()).toBe(true);

    recordOffsiteBackupStatus(db, true, files[1]!);
    await writeFile(join(directory, files[1]!), 'corrupt backup');
    await utimes(join(directory, files[1]!), new Date(dates[1]!), new Date(dates[1]!));
    await expect(pruneOffsiteBackedLocalSnapshots(db, { directory, key, keyVersion: 'fixture', retain: 1 })).rejects.toThrow();
    expect(await Bun.file(join(directory, files[1]!)).exists()).toBe(true);
    expect(await Bun.file(join(directory, files[2]!)).exists()).toBe(true);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a backup directory over its size limit refuses new snapshots instead of growing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'steward-backup-full-'));
  const db = createDatabase(':memory:');
  const key = randomBytes(32);
  try {
    await maintainEncryptedBackups(db, { directory, key, keyVersion: 'fixture', now: new Date('2026-09-20T00:00:00Z') });
    // Sparse file: reports 2 GiB + 1 byte without using that disk space.
    const full = join(directory, 'steward-backup-20260921T000000Z-0000000000000000.enc');
    await writeFile(full, '');
    await truncate(full, 2 * 1024 * 1024 * 1024 + 1);
    const before = await readdir(directory);
    await expect(maintainEncryptedBackups(db, { directory, key, keyVersion: 'fixture', now: new Date('2026-09-22T00:00:00Z') })).rejects.toThrow('BACKUP_DIRECTORY_SIZE_LIMIT');
    expect((await readdir(directory)).sort()).toEqual(before.sort());
    expect(getMaintenanceStatus(db).backups.lastError).toBe('BACKUP_DIRECTORY_SIZE_LIMIT');
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});


test('backup preflight reserves space for the entire encrypted snapshot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'steward-backup-near-full-'));
  const db = createDatabase(':memory:');
  const key = randomBytes(32);
  try {
    const first = await maintainEncryptedBackups(db, { directory, key, keyVersion: 'fixture' });
    const firstBytes = (await stat(join(directory, first.created))).size;
    const filler = join(directory, 'steward-backup-20260921T000000Z-0000000000000000.enc');
    await writeFile(filler, '');
    await truncate(filler, 2 * 1024 * 1024 * 1024 - firstBytes - 100);
    const before = (await readdir(directory)).sort();
    await expect(maintainEncryptedBackups(db, { directory, key, keyVersion: 'fixture' })).rejects.toThrow('BACKUP_SIZE_LIMIT');
    expect((await readdir(directory)).sort()).toEqual(before);
    expect(getMaintenanceStatus(db).backups.lastError).toBe('BACKUP_SIZE_LIMIT');
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});


test('backup preflight reserves one managed filename below the file-count limit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'steward-backup-file-count-'));
  const db = createDatabase(':memory:');
  const key = randomBytes(32);
  try {
    await maintainEncryptedBackups(db, { directory, key, keyVersion: 'fixture' });
    for (let i = 0; i < 999; i++) {
      await writeFile(join(directory, `steward-backup-20260921T000000Z-${i.toString(16).padStart(16, '0')}.enc`), '');
    }
    const before = (await readdir(directory)).length;
    await expect(maintainEncryptedBackups(db, { directory, key, keyVersion: 'fixture' })).rejects.toThrow('BACKUP_DIRECTORY_FILE_LIMIT');
    expect((await readdir(directory)).length).toBe(before);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});
