import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compactDatabaseFreePages, requiredCompactionSpaceBytes, safeCompactionAlertCode } from './sqlite-compaction';

test('startup compaction reclaims large free pages without losing live rows or WAL mode', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'steward-compact-'));
  const path = join(dir, 'live.sqlite');
  const db = new Database(path);
  try {
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE keep(id INTEGER PRIMARY KEY, value TEXT); CREATE TABLE discarded(value BLOB)');
    db.query('INSERT INTO keep VALUES (?,?)').run(1, 'preserved');
    db.exec('INSERT INTO discarded SELECT zeroblob(35 * 1024 * 1024)');
    db.exec('DELETE FROM discarded');
    const before = (await stat(path)).size;
    const result = await compactDatabaseFreePages(db);
    expect(result.compacted).toBe(true);
    expect(result.beforeBytes).toBe(before);
    expect(result.freeBytes).toBeGreaterThan(32 * 1024 * 1024);
    expect(result.afterBytes).toBeLessThan(before / 10);
    expect(db.query('SELECT * FROM keep').get()).toEqual({ id: 1, value: 'preserved' });
    expect(db.query('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect((await compactDatabaseFreePages(db)).compacted).toBe(false);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('compaction preflight reserves space for uncheckpointed WAL pages', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'steward-compact-wal-'));
  const path = join(dir, 'live.sqlite');
  const db = new Database(path);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE discarded(value BLOB)');
    db.exec('INSERT INTO discarded SELECT zeroblob(40 * 1024 * 1024)');
    db.exec('DELETE FROM discarded');
    const mainFileBytes = (await stat(path)).size;
    const pages = (db.query('PRAGMA page_count').get() as { page_count: number }).page_count;
    const pageSize = (db.query('PRAGMA page_size').get() as { page_size: number }).page_size;
    expect(pages * pageSize).toBeGreaterThan(mainFileBytes * 10);
    expect(requiredCompactionSpaceBytes(mainFileBytes, pages, pageSize))
      .toBe(2 * pages * pageSize + 64 * 1024 * 1024);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('compaction alerts preserve only allowlisted error codes', () => {
  expect(safeCompactionAlertCode(Error('DB_COMPACT_INTEGRITY_FAILED'))).toBe('DB_COMPACT_INTEGRITY_FAILED');
  expect(safeCompactionAlertCode(Error('DB_COMPACT_WAL_BUSY'))).toBe('DB_COMPACT_WAL_BUSY');
  expect(safeCompactionAlertCode(Error('secret connection string'))).toBe('DB_COMPACT_FAILED');
  expect(safeCompactionAlertCode('DB_COMPACT_INTEGRITY_FAILED')).toBe('DB_COMPACT_FAILED');
});
