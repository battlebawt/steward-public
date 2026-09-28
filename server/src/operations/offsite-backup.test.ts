import { test, expect } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase } from '../db';
import { backupDatabase } from './backup';
import { createOffsiteBackupStore, offsiteConfigFromEnv, uploadTimeoutMs } from './offsite-backup';
import { getMaintenanceStatus, recordOffsiteBackupStatus } from './maintenance';

test('S3-compatible fixture retries encrypted upload, lists it and restores only a verified artifact to a new database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'steward-s3-fixture-'));
  const key = randomBytes(32), wrongKey = randomBytes(32);
  const filename = 'steward-backup-20260924T150000Z-0123456789abcdef.enc';
  const snapshot = join(directory, filename), destination = join(directory, 'restored.sqlite');
  const db = createDatabase(':memory:');
  db.query('INSERT INTO users(id,wallet_address,created_at) VALUES(?,?,?)').run('fixture-user', '0x0000000000000000000000000000000000000001', new Date().toISOString());
  await backupDatabase(db, snapshot, key, 'fixture');
  const original = await readFile(snapshot);
  let stored: Uint8Array | undefined, puts = 0, failAll = false;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'PUT') {
      puts++;
      const incoming = new Uint8Array(await request.arrayBuffer());
      if (failAll || puts === 1) return new Response('<Error><Code>InternalError</Code><Message>Fixture retry</Message></Error>', { status: 503, headers: { 'content-type': 'application/xml' } });
      stored = incoming;
      return new Response('', { status: 200, headers: { ETag: '"fixture"' } });
    }
    if (request.method === 'GET' && url.searchParams.get('list-type') === '2') {
      const body = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>fixture-bucket</Name><Prefix>pilot/backups/</Prefix><KeyCount>${stored ? 1 : 0}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${stored ? `<Contents><Key>pilot/backups/${filename}</Key><Size>${stored.length}</Size></Contents>` : ''}</ListBucketResult>`;
      return new Response(body, { headers: { 'content-type': 'application/xml' } });
    }
    if (request.method === 'GET' && stored) return new Response(Uint8Array.from(stored).buffer, { headers: { 'content-length': String(stored.length) } });
    return new Response('missing', { status: 404 });
  } });
  const env = { STEWARD_BACKUP_OFFSITE_ENABLED: 'true', STEWARD_BACKUP_OFFSITE_ENDPOINT: `http://127.0.0.1:${server.port}`,
    STEWARD_BACKUP_OFFSITE_REGION: 'us-east-1', STEWARD_BACKUP_OFFSITE_BUCKET: 'fixture-bucket',
    STEWARD_BACKUP_OFFSITE_PREFIX: 'pilot/backups', STEWARD_BACKUP_OFFSITE_ACCESS_KEY_ID: 'fixture',
    STEWARD_BACKUP_OFFSITE_SECRET_ACCESS_KEY: 'fixture-secret' };
  const config = offsiteConfigFromEnv(env, true)!;
  const store = createOffsiteBackupStore(config);
  try {
    expect(() => offsiteConfigFromEnv(env)).toThrow('OFFSITE_ENDPOINT_INVALID');
    expect(() => offsiteConfigFromEnv({ ...env, STEWARD_BACKUP_OFFSITE_PREFIX: '../other' }, true)).toThrow('OFFSITE_CONFIG_INVALID');
    expect(() => offsiteConfigFromEnv({ ...env, STEWARD_BACKUP_OFFSITE_SECRET_ACCESS_KEY: '' }, true)).toThrow('OFFSITE_CONFIG_INVALID');
    expect((await store.upload(snapshot, key, 'fixture')).uploaded).toBe(true);
    expect(puts).toBe(2);
    expect(Buffer.from(stored!)).toEqual(original);
    expect(Buffer.from(stored!).includes(Buffer.from('fixture-user'))).toBe(false);
    expect((await store.list()).files).toEqual([filename]);
    await expect(store.downloadAndRestore(filename, join(directory, 'wrong.sqlite'), wrongKey, 'fixture')).rejects.toThrow('OFFSITE_RESTORE_FAILED');
    expect(await Bun.file(join(directory, 'wrong.sqlite')).exists()).toBe(false);
    expect((await store.downloadAndRestore(filename, destination, key, 'fixture')).restored).toBe(true);
    const restored = createDatabase(destination);
    try { expect(restored.query('SELECT id FROM users').get()).toEqual({ id: 'fixture-user' }); }
    finally { restored.close(); }
    await expect(store.downloadAndRestore(filename, destination, key, 'fixture')).rejects.toThrow();
    failAll = true;
    await expect(store.upload(snapshot, key, 'fixture')).rejects.toThrow('OFFSITE_UPLOAD_FAILED');
    expect(puts).toBe(4);
    recordOffsiteBackupStatus(db, false);
    expect(getMaintenanceStatus(db).offsite.lastError).toBe('OFFSITE_UPLOAD_FAILED');
    recordOffsiteBackupStatus(db, true);
    expect(getMaintenanceStatus(db).offsite.lastError).toBeNull();
    await writeFile(join(directory, 'not-backup.enc'), 'plain');
    await expect(store.upload(join(directory, 'not-backup.enc'), key, 'fixture')).rejects.toThrow('OFFSITE_FILENAME_INVALID');
  } finally { store.destroy(); server.stop(true); db.close(); await rm(directory, { recursive: true, force: true }); }
});


test('larger offsite uploads receive a size-aware bounded deadline', () => {
  expect(uploadTimeoutMs(1)).toBeGreaterThan(15_000);
  expect(uploadTimeoutMs(222 * 1024 * 1024)).toBeGreaterThan(4 * 60_000);
  expect(uploadTimeoutMs(2 * 1024 * 1024 * 1024)).toBeLessThanOrEqual(45 * 60_000);
  expect(() => uploadTimeoutMs(2 * 1024 * 1024 * 1024 + 1)).toThrow('OFFSITE_BACKUP_SIZE_INVALID');
});
