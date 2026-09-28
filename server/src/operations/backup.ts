import { Database } from 'bun:sqlite';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, link, mkdtemp, rm, open, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';

const MAGIC = 'STEWARD-BACKUP-2\n';
const MAX_HEADER_BYTES = 256;
const TAG_BYTES = 16;
const MAX_BACKUP_BYTES = 2 * 1024 * 1024 * 1024;
const KEY_VERSION = /^[a-zA-Z0-9_-]{1,64}$/;

type BackupHeader = { version: 2; keyVersion: string; iv: string };

async function snapshotDatabase(db: Database) {
  const scratch = await mkdtemp(join(tmpdir(), 'steward-backup-snapshot-'));
  const path = join(scratch, 'snapshot.sqlite');
  try {
    // VACUUM INTO gives an independently openable, compact snapshot even for WAL and :memory: databases.
    db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
    return { scratch, path };
  } catch (error) { await rm(scratch, { recursive: true, force: true }); throw error; }
}

async function writeAll(file: Awaited<ReturnType<typeof open>>, bytes: Buffer) {
  for (let offset = 0; offset < bytes.length;) {
    const result = await file.write(bytes, offset, bytes.length - offset);
    if (!result.bytesWritten) throw Error('BACKUP_WRITE_FAILED');
    offset += result.bytesWritten;
  }
}

/** Consistent SQLite snapshot streamed through AES-GCM; the plaintext snapshot never enters a whole-file JS buffer. */
export async function backupDatabase(db: Database, output: string, key: Uint8Array, keyVersion: string, maxOutputBytes = MAX_BACKUP_BYTES) {
  if (key.length !== 32 || !KEY_VERSION.test(keyVersion)) throw new Error('INVALID_BACKUP_KEY');
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  const { scratch, path } = await snapshotDatabase(db);
  const temp = `${output}.${randomBytes(8).toString('hex')}.partial`;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const snapshotBytes = (await stat(path)).size;
    if (snapshotBytes < 1) throw Error('BACKUP_SIZE_INVALID');
    const iv = randomBytes(12);
    const header = Buffer.from(`${MAGIC}${JSON.stringify({ version: 2, keyVersion, iv: iv.toString('base64') } satisfies BackupHeader)}\n`);
    if (snapshotBytes + header.length + TAG_BYTES > Math.min(MAX_BACKUP_BYTES, maxOutputBytes)) throw Error('BACKUP_SIZE_LIMIT');
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(header);
    file = await open(temp, 'wx', 0o600);
    await writeAll(file, header);
    for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) await writeAll(file, cipher.update(chunk as Buffer));
    await writeAll(file, cipher.final());
    await writeAll(file, cipher.getAuthTag());
    await file.sync();
    await file.close(); file = undefined;
    // Hard-link publication refuses replacement of an existing retained snapshot.
    await link(temp, output);
    return { bytes: (await stat(output)).size, keyVersion, createdAt: new Date().toISOString() };
  } finally {
    await file?.close();
    await rm(temp, { force: true });
    await rm(scratch, { recursive: true, force: true });
  }
}

async function v2Header(input: string) {
  const file = await open(input, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < MAGIC.length + TAG_BYTES + 1 || info.size > MAX_BACKUP_BYTES) throw Error('INVALID_BACKUP');
    const first = Buffer.alloc(Math.min(MAX_HEADER_BYTES, info.size));
    await file.read(first, 0, first.length, 0);
    if (!first.subarray(0, MAGIC.length).equals(Buffer.from(MAGIC))) return null;
    const newline = first.indexOf(10, MAGIC.length);
    if (newline < 0 || newline + 1 >= info.size - TAG_BYTES) throw Error('INVALID_BACKUP');
    let header: BackupHeader;
    try { header = JSON.parse(first.subarray(MAGIC.length, newline).toString('utf8')) as BackupHeader; }
    catch { throw Error('INVALID_BACKUP'); }
    if (header.version !== 2 || !KEY_VERSION.test(header.keyVersion) || typeof header.iv !== 'string') throw Error('INVALID_BACKUP');
    const iv = Buffer.from(header.iv, 'base64');
    if (iv.length !== 12 || iv.toString('base64') !== header.iv) throw Error('INVALID_BACKUP');
    const tag = Buffer.alloc(TAG_BYTES);
    await file.read(tag, 0, TAG_BYTES, info.size - TAG_BYTES);
    return { header, aad: first.subarray(0, newline + 1), iv, tag, start: newline + 1, end: info.size - TAG_BYTES - 1 };
  } finally { await file.close(); }
}

async function verifySqlite(path: string) {
  let snapshot: Database | undefined;
  try {
    snapshot = new Database(path, { readonly: true });
    const check = snapshot.query('PRAGMA integrity_check').get() as { integrity_check: string };
    if (check.integrity_check !== 'ok') throw Error('BACKUP_INTEGRITY_FAILED');
  } catch (error) {
    if (error instanceof Error && error.message === 'BACKUP_INTEGRITY_FAILED') throw error;
    throw Error('BACKUP_INVALID_SQLITE');
  } finally { snapshot?.close(); }
}

async function decryptV2(input: string, destination: string, key: Uint8Array, expectedKeyVersion?: string) {
  const record = await v2Header(input);
  if (!record || key.length !== 32) throw Error('INVALID_BACKUP');
  if (expectedKeyVersion !== undefined && record.header.keyVersion !== expectedKeyVersion) throw Error('BACKUP_KEY_VERSION_MISMATCH');
  const decipher = createDecipheriv('aes-256-gcm', key, record.iv);
  decipher.setAAD(record.aad);
  decipher.setAuthTag(record.tag);
  try {
    await pipeline(createReadStream(input, { start: record.start, end: record.end, highWaterMark: 64 * 1024 }), decipher,
      createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
  } catch { throw Error('BACKUP_AUTH_FAILED'); }
  await verifySqlite(destination);
  return { keyVersion: record.header.keyVersion, bytes: (await stat(destination)).size };
}

/** Reads the app's version-1 JSON envelope without buffering its base64 ciphertext. */
async function legacyHeader(input: string) {
  const file = await open(input, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 100 || info.size > MAX_BACKUP_BYTES) throw Error('INVALID_BACKUP');
    const first = Buffer.alloc(Math.min(512, info.size));
    const { bytesRead } = await file.read(first, 0, first.length, 0);
    const prefix = first.subarray(0, bytesRead).toString('ascii');
    const marker = ',"ciphertext":"';
    const offset = prefix.indexOf(marker);
    if (!prefix.startsWith('{"version":1,') || offset < 0) throw Error('INVALID_BACKUP');
    let fields: { version?: unknown; keyVersion?: unknown; iv?: unknown; tag?: unknown };
    try { fields = JSON.parse(prefix.slice(0, offset) + '}'); } catch { throw Error('INVALID_BACKUP'); }
    if (fields.version !== 1 || typeof fields.keyVersion !== 'string' || !KEY_VERSION.test(fields.keyVersion) ||
      typeof fields.iv !== 'string' || typeof fields.tag !== 'string') throw Error('INVALID_BACKUP');
    const iv = Buffer.from(fields.iv, 'base64'), tag = Buffer.from(fields.tag, 'base64');
    if (iv.length !== 12 || iv.toString('base64') !== fields.iv || tag.length !== TAG_BYTES || tag.toString('base64') !== fields.tag) throw Error('INVALID_BACKUP');
    const tail = Buffer.alloc(2);
    await file.read(tail, 0, 2, info.size - 2);
    if (tail.toString() !== '"}') throw Error('INVALID_BACKUP');
    const start = offset + marker.length, end = info.size - 3;
    if (end < start || (end - start + 1) % 4 !== 0) throw Error('INVALID_BACKUP');
    return { keyVersion: fields.keyVersion, iv, tag, start, end };
  } finally { await file.close(); }
}

async function decryptLegacyToFile(input: string, destination: string, key: Uint8Array, expectedKeyVersion?: string) {
  if (key.length !== 32) throw Error('INVALID_BACKUP');
  const header = await legacyHeader(input);
  if (expectedKeyVersion !== undefined && header.keyVersion !== expectedKeyVersion) throw Error('BACKUP_KEY_VERSION_MISMATCH');
  const decipher = createDecipheriv('aes-256-gcm', key, header.iv);
  decipher.setAAD(Buffer.from(`STEWARD-BACKUP-1:${header.keyVersion}`));
  decipher.setAuthTag(header.tag);
  const output = await open(destination, 'wx', 0o600);
  let carry = '';
  try {
    for await (const chunk of createReadStream(input, { start: header.start, end: header.end, highWaterMark: 64 * 1024 })) {
      const encoded = carry + (chunk as Buffer).toString('ascii');
      const ready = encoded.length - encoded.length % 4;
      const part = encoded.slice(0, ready);
      carry = encoded.slice(ready);
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(part)) throw Error('INVALID_BACKUP');
      const bytes = Buffer.from(part, 'base64');
      if (bytes.toString('base64') !== part) throw Error('INVALID_BACKUP');
      await writeAll(output, decipher.update(bytes));
    }
    if (carry) throw Error('INVALID_BACKUP');
    await writeAll(output, decipher.final());
    await output.sync();
  } catch (error) {
    if (error instanceof Error && error.message === 'INVALID_BACKUP') throw error;
    throw Error('BACKUP_AUTH_FAILED');
  } finally { await output.close(); }
  await verifySqlite(destination);
  return { keyVersion: header.keyVersion, bytes: (await stat(destination)).size };
}

/** Restores into a NEW isolated file; never overwrites a running database. */
export async function restoreDatabase(input: string, output: string, key: Uint8Array) {
  const scratch = await mkdtemp(join(dirname(output), '.steward-restore-'));
  const path = join(scratch, 'snapshot.sqlite');
  try {
    const record = await v2Header(input);
    const result = record ? await decryptV2(input, path, key) : await decryptLegacyToFile(input, path, key);
    await link(path, output);
    return { restored: true, keyVersion: result.keyVersion };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

/** Authenticates and checks a snapshot without creating a restore destination. */
export async function verifyBackup(input: string, key: Uint8Array, expectedKeyVersion?: string) {
  const scratch = await mkdtemp(join(tmpdir(), 'steward-backup-verify-'));
  try {
    const record = await v2Header(input);
    const result = record
      ? await decryptV2(input, join(scratch, 'snapshot.sqlite'), key, expectedKeyVersion)
      : await decryptLegacyToFile(input, join(scratch, 'snapshot.sqlite'), key, expectedKeyVersion);
    return { verified: true, ...result };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
