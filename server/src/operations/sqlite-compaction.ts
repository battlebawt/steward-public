import type { Database } from 'bun:sqlite';
import { stat, statfs } from 'node:fs/promises';
import { dirname } from 'node:path';

export type CompactionResult = { compacted: boolean; beforeBytes: number; afterBytes: number; freeBytes: number; reason?: 'small' | 'insufficient-space' };
const MIN_FREE_BYTES = 32 * 1024 * 1024;
const COMPACTION_ALERT_CODES = new Set(['DB_COMPACT_INTEGRITY_FAILED', 'DB_COMPACT_WAL_BUSY']);

export function safeCompactionAlertCode(error: unknown): string {
  return error instanceof Error && COMPACTION_ALERT_CODES.has(error.message) ? error.message : 'DB_COMPACT_FAILED';
}

export function requiredCompactionSpaceBytes(mainFileBytes: number, pages: number, pageSize: number): number {
  // The WAL can contain pages that have not yet been checkpointed into the main file.
  // Reserve space for that logical database, plus VACUUM's temporary copy.
  return Math.max(mainFileBytes, pages * pageSize) * 2 + 64 * 1024 * 1024;
}

/** Startup-only compaction, before indexers, maintenance and HTTP handlers can use this connection. */
export async function compactDatabaseFreePages(db: Database): Promise<CompactionResult> {
  if (db.filename === ':memory:') return { compacted: false, beforeBytes: 0, afterBytes: 0, freeBytes: 0, reason: 'small' };
  const pages = (db.query('PRAGMA page_count').get() as { page_count: number }).page_count;
  const free = (db.query('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count;
  const pageSize = (db.query('PRAGMA page_size').get() as { page_size: number }).page_size;
  const beforeBytes = (await stat(db.filename)).size;
  const freeBytes = free * pageSize;
  if (freeBytes < MIN_FREE_BYTES || free * 4 < pages) return { compacted: false, beforeBytes, afterBytes: beforeBytes, freeBytes, reason: 'small' };
  // Include uncheckpointed WAL pages, not only the on-disk main file.
  const space = await statfs(dirname(db.filename));
  if (Number(space.bavail) * Number(space.bsize) < requiredCompactionSpaceBytes(beforeBytes, pages, pageSize))
    return { compacted: false, beforeBytes, afterBytes: beforeBytes, freeBytes, reason: 'insufficient-space' };
  const check = db.query('PRAGMA quick_check').get() as { quick_check: string };
  if (check.quick_check !== 'ok') throw Error('DB_COMPACT_INTEGRITY_FAILED');
  const checkpoint = db.query('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number };
  if (checkpoint.busy) throw Error('DB_COMPACT_WAL_BUSY');
  db.exec('VACUUM');
  const after = db.query('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number };
  if (after.busy) throw Error('DB_COMPACT_WAL_BUSY');
  const verified = db.query('PRAGMA quick_check').get() as { quick_check: string };
  if (verified.quick_check !== 'ok') throw Error('DB_COMPACT_INTEGRITY_FAILED');
  return { compacted: true, beforeBytes, afterBytes: (await stat(db.filename)).size, freeBytes };
}
