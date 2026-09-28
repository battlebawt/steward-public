import { test, expect } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase } from '../db';
import { decryptRecord, encryptRecord } from '../crypto';
import { initOperations, enqueue, emailChannel, runOne, recordDelivered, recordDeliveryFailure } from './jobs';
import { initIndexer, registerIndexAccount } from './indexer';
import { getOperationalStatus, maintainEncryptedBackups, verifyManagedBackups } from './maintenance';
import { restoreDatabase } from './backup';

test('persistent operator drill distinguishes accepted, delivered and failed notices and restores an isolated encrypted snapshot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'steward-hosted-ops-drill-'));
  const databasePath = join(directory, 'live.sqlite');
  const backupsPath = join(directory, 'backups');
  const restoredPath = join(directory, 'isolated-restore.sqlite');
  const serviceKey = randomBytes(32), backupKey = randomBytes(32);
  const now = new Date().toISOString();
  let db = createDatabase(databasePath);
  try {
    initOperations(db); initIndexer(db);
    db.query('INSERT INTO users(id,wallet_address,created_at) VALUES(?,?,?)').run('parent', '0x0000000000000000000000000000000000000001', now);
    db.query('INSERT INTO accounts(id,chain_id,address,parent_user_id,created_at) VALUES(?,?,?,?,?)').run('family', 31337, '0x0000000000000000000000000000000000000002', 'parent', now);
    const privateNote = 'disposable family record';
    db.query('INSERT INTO attachments(id,account_id,storage_key,filename_ciphertext,mime_type,size_bytes,sha256,state,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run('fixture', 'family', JSON.stringify(await encryptRecord(privateNote, serviceKey, 'fixture', 'fixture')),
        JSON.stringify(await encryptRecord('fixture.txt', serviceKey, 'fixture', 'fixture:name')), 'text/plain', privateNote.length,
        '0'.repeat(64), 'quarantined', 'parent', now);
    registerIndexAccount(db, 31337, '0x0000000000000000000000000000000000000002', 'family', 100);
    enqueue(db, { accountId: 'family', kind: 'continuity.requested', dedupeKey: 'one', payload: { resourceId: 'case-one' } }, 0);
    enqueue(db, { accountId: 'family', kind: 'continuity.approved', dedupeKey: 'two', payload: { resourceId: 'case-two' } }, 0);
    const sent: string[] = [];
    const channel = emailChannel(async input => { sent.push(input.idempotencyKey); return { id: `provider-${sent.length}` }; });
    expect(await runOne(db, 'worker', channel, 1)).toBe(true);
    expect(await runOne(db, 'worker', channel, 1)).toBe(true);
    expect(getOperationalStatus(db).outbox.accepted).toBe(2);
    expect(getOperationalStatus(db).outbox.delivered).toBe(0);
    db.close();

    // A fresh process opens the same volume. Provider acceptance survives restart.
    db = createDatabase(databasePath);
    expect(getOperationalStatus(db).outbox.accepted).toBe(2);
    recordDelivered(db, 'provider-1', 2);
    recordDeliveryFailure(db, 'provider-2', 3);
    const status = getOperationalStatus(db);
    expect(status.outbox).toMatchObject({ pending: 0, accepted: 0, delivered: 1, dead: 1 });
    expect(status.lastDeliveryFailure).toBe('PROVIDER_DELIVERY_FAILED');
    expect(status.indexer).toEqual([{ chainId: 31337, nextBlock: 100, lastSuccessAt: null }]);
    expect(JSON.stringify(status)).not.toContain('case-one');

    const backup = await maintainEncryptedBackups(db, { directory: backupsPath, key: backupKey, keyVersion: 'fixture' });
    expect(backup.verificationFailures).toEqual([]);
    expect((await verifyManagedBackups(backupsPath, backupKey, 'fixture')).verified).toContain(backup.created);
    await restoreDatabase(join(backupsPath, backup.created), restoredPath, backupKey);
    const restored = createDatabase(restoredPath);
    try {
      expect(getOperationalStatus(restored).outbox).toMatchObject({ delivered: 1, dead: 1 });
      const attachment = restored.query('SELECT storage_key,state FROM attachments WHERE id=?').get('fixture') as { storage_key: string; state: string };
      expect(attachment.state).toBe('quarantined');
      await expect(decryptRecord(JSON.parse(attachment.storage_key), backupKey, 'fixture')).rejects.toThrow();
      expect(new TextDecoder().decode(await decryptRecord(JSON.parse(attachment.storage_key), serviceKey, 'fixture'))).toBe(privateNote);
    } finally { restored.close(); }
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});
