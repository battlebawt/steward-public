import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { restoreDatabase, verifyBackup } from './backup';

const MANAGED_NAME = /^steward-backup-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{16}\.enc$/;
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
/** Allow at least 1 MiB/s plus setup time; large verified snapshots cannot use a fixed 15-second deadline. */
export function uploadTimeoutMs(bytes: number) {
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_BYTES) throw Error('OFFSITE_BACKUP_SIZE_INVALID');
  return Math.min(45 * 60_000, 60_000 + Math.ceil(bytes / (1024 * 1024)) * 1000);
}

export type OffsiteConfig = {
  endpoint: string; region: string; bucket: string; prefix: string;
  accessKeyId: string; secretAccessKey: string;
};

export function offsiteConfigFromEnv(env: Record<string, string | undefined>, allowLoopbackHttp = false): OffsiteConfig | undefined {
  if (env.STEWARD_BACKUP_OFFSITE_ENABLED !== 'true') {
    if (Object.keys(env).some(key => key.startsWith('STEWARD_BACKUP_OFFSITE_') && key !== 'STEWARD_BACKUP_OFFSITE_ENABLED' && env[key])) throw Error('OFFSITE_BACKUP_DISABLED_WITH_CONFIG');
    return undefined;
  }
  const config = {
    endpoint: env.STEWARD_BACKUP_OFFSITE_ENDPOINT ?? '', region: env.STEWARD_BACKUP_OFFSITE_REGION ?? '',
    bucket: env.STEWARD_BACKUP_OFFSITE_BUCKET ?? '', prefix: env.STEWARD_BACKUP_OFFSITE_PREFIX ?? '',
    accessKeyId: env.STEWARD_BACKUP_OFFSITE_ACCESS_KEY_ID ?? '', secretAccessKey: env.STEWARD_BACKUP_OFFSITE_SECRET_ACCESS_KEY ?? '',
  };
  let url: URL;
  try { url = new URL(config.endpoint); } catch { throw Error('OFFSITE_ENDPOINT_INVALID'); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.origin !== config.endpoint || url.username || url.password || url.search || url.hash ||
      (loopback && !allowLoopbackHttp) ||
      (url.protocol !== 'https:' && !(allowLoopbackHttp && url.protocol === 'http:' && loopback))) throw Error('OFFSITE_ENDPOINT_INVALID');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]{1,61}[a-zA-Z0-9]$/.test(config.bucket) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_/-]{0,127}$/.test(config.prefix) || config.prefix.includes('//') || config.prefix.endsWith('/') ||
      !/^[a-zA-Z0-9-]{1,64}$/.test(config.region) || !config.accessKeyId || !config.secretAccessKey ||
      /[\r\n]/.test(config.accessKeyId + config.secretAccessKey)) throw Error('OFFSITE_CONFIG_INVALID');
  return config;
}

export function createOffsiteBackupStore(config: OffsiteConfig) {
  const client = new S3Client({ endpoint: config.endpoint, region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    forcePathStyle: true, maxAttempts: 1, requestChecksumCalculation: 'WHEN_REQUIRED' });
  const key = (filename: string) => {
    if (!MANAGED_NAME.test(filename) || basename(filename) !== filename) throw Error('OFFSITE_FILENAME_INVALID');
    return `${config.prefix}/${filename}`;
  };
  const send = async <T>(operation: () => Promise<T>): Promise<T> => {
    let failure: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await operation(); }
      catch (error) { failure = error; if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 150)); }
    }
    throw failure;
  };
  return {
    async upload(file: string, backupKey: Uint8Array, keyVersion: string) {
      const filename = basename(file), remoteKey = key(filename);
      await verifyBackup(file, backupKey, keyVersion);
      const info = await stat(file);
      if (!info.isFile() || info.size < 1 || info.size > MAX_BYTES) throw Error('OFFSITE_BACKUP_SIZE_INVALID');
      try {
        await send(async () => {
          const body = createReadStream(file);
          try { await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: remoteKey, Body: body, ContentLength: info.size, ContentType: 'application/octet-stream' }), { abortSignal: AbortSignal.timeout(uploadTimeoutMs(info.size)) }); }
          finally { body.destroy(); }
        });
      } catch { throw Error('OFFSITE_UPLOAD_FAILED'); }
      return { uploaded: true, filename };
    },
    async list() {
      try {
        const files: string[] = [];
        let token: string | undefined;
        for (let page = 0; page < 10; page++) {
          const result = await send(() => client.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: `${config.prefix}/`, MaxKeys: 1000, ContinuationToken: token }), { abortSignal: AbortSignal.timeout(15_000) }));
          for (const item of result.Contents ?? []) {
            const filename = item.Key?.slice(config.prefix.length + 1);
            if (filename && MANAGED_NAME.test(filename)) files.push(filename);
          }
          if (!result.IsTruncated) return { files: files.sort().reverse(), truncated: false };
          if (!result.NextContinuationToken) throw Error('OFFSITE_LIST_INCOMPLETE');
          token = result.NextContinuationToken;
        }
        return { files: files.sort().reverse(), truncated: true };
      } catch { throw Error('OFFSITE_LIST_FAILED'); }
    },
    async downloadAndRestore(filename: string, destination: string, backupKey: Uint8Array, keyVersion: string) {
      const remoteKey = key(filename);
      const scratch = await mkdtemp(join(tmpdir(), 'steward-offsite-restore-'));
      const encrypted = join(scratch, filename);
      try {
        await send(async () => {
          await rm(encrypted, { force: true });
          const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: remoteKey }), { abortSignal: AbortSignal.timeout(15_000) });
          if (!response.Body) throw Error('OFFSITE_DOWNLOAD_INVALID');
          if (response.ContentLength !== undefined && response.ContentLength > MAX_BYTES) {
            if ('destroy' in response.Body && typeof response.Body.destroy === 'function') response.Body.destroy();
            throw Error('OFFSITE_DOWNLOAD_INVALID');
          }
          let size = 0;
          const limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) { size += chunk.length; callback(size > MAX_BYTES ? Error('OFFSITE_DOWNLOAD_TOO_LARGE') : null, chunk); } });
          await pipeline(response.Body as NodeJS.ReadableStream, limiter, createWriteStream(encrypted, { flags: 'wx', mode: 0o600 }), { signal: AbortSignal.timeout(uploadTimeoutMs(response.ContentLength ?? MAX_BYTES)) });
        });
        await verifyBackup(encrypted, backupKey, keyVersion);
        await restoreDatabase(encrypted, destination, backupKey);
        return { restored: true, filename };
      } catch (error) {
        if (error instanceof Error && error.message === 'EEXIST') throw error;
        throw Error('OFFSITE_RESTORE_FAILED');
      } finally { await rm(scratch, { recursive: true, force: true }); }
    },
    destroy() { client.destroy(); },
  };
}
