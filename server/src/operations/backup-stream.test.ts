import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupDatabase, restoreDatabase, verifyBackup } from './backup';

test('streamed encrypted snapshots preserve a large WAL database and fail closed on tampering', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'steward-stream-backup-'));
  const database = join(dir, 'live.sqlite'), backup = join(dir, 'backup.enc'), restored = join(dir, 'restored.sqlite');
  const key = randomBytes(32), db = new Database(database);
  try {
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE records(id INTEGER PRIMARY KEY, value BLOB); INSERT INTO records VALUES (1,zeroblob(8 * 1024 * 1024))');
    const result = await backupDatabase(db, backup, key, 'fixture');
    expect(result.bytes).toBeGreaterThan(8 * 1024 * 1024);
    const marker = Buffer.alloc(17);
    const handle = Bun.file(backup);
    const start = Buffer.from(await handle.slice(0, marker.length).arrayBuffer());
    expect(start.toString()).toBe('STEWARD-BACKUP-2\n');
    expect((await verifyBackup(backup, key, 'fixture')).bytes).toBeGreaterThan(8 * 1024 * 1024);
    await expect(verifyBackup(backup, randomBytes(32), 'fixture')).rejects.toThrow('BACKUP_AUTH_FAILED');
    await restoreDatabase(backup, restored, key);
    const copy = new Database(restored, { readonly: true });
    try { expect((copy.query('SELECT length(value) AS n FROM records').get() as {n:number}).n).toBe(8 * 1024 * 1024); }
    finally { copy.close(); }
    await expect(restoreDatabase(backup, restored, key)).rejects.toThrow();
    const bytes = await readFile(backup);
    bytes[Math.floor(bytes.length / 2)]! ^= 1;
    await writeFile(backup, bytes);
    await expect(verifyBackup(backup, key)).rejects.toThrow('BACKUP_AUTH_FAILED');
    await expect(restoreDatabase(backup, join(dir, 'tampered.sqlite'), key)).rejects.toThrow('BACKUP_AUTH_FAILED');
    expect(await Bun.file(join(dir, 'tampered.sqlite')).exists()).toBe(false);
    expect((await stat(restored)).size).toBeGreaterThan(8 * 1024 * 1024);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('pre-existing JSON version-1 encrypted backups remain verifiable and restorable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'steward-legacy-backup-'));
  const input = join(dir, 'legacy.enc'), output = join(dir, 'restored.sqlite');
  const key = randomBytes(32), iv = randomBytes(12), db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE note(value TEXT); INSERT INTO note VALUES (\'legacy preserved\')');
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from('STEWARD-BACKUP-1:v1'));
    const ciphertext = Buffer.concat([cipher.update(db.serialize()), cipher.final()]);
    await writeFile(input, JSON.stringify({ version: 1, keyVersion: 'v1', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }));
    expect((await verifyBackup(input, key, 'v1')).verified).toBe(true);
    await restoreDatabase(input, output, key);
    const restored = new Database(output, { readonly: true });
    try { expect(restored.query('SELECT value FROM note').get()).toEqual({ value: 'legacy preserved' }); }
    finally { restored.close(); }
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});
