import { offsiteConfigFromEnv, createOffsiteBackupStore } from '../server/src/operations/offsite-backup';

function backupKey(env: Record<string, string | undefined>) {
  const encoded = env.STEWARD_BACKUP_KEY;
  if (!encoded) throw Error('BACKUP_KEY_REQUIRED');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw Error('BACKUP_KEY_INVALID');
  return key;
}

export async function runOffsiteBackup(argv = process.argv.slice(2), env: Record<string, string | undefined> = process.env) {
  const [command, filename, destination, extra] = argv;
  if (extra || (command !== 'list' && command !== 'download-restore') ||
      (command === 'list' && (filename || destination)) ||
      (command === 'download-restore' && (!filename || !destination))) throw Error('Usage: bun scripts/offsite-backup.ts list | download-restore FILENAME NEW_DATABASE');
  const config = offsiteConfigFromEnv(env);
  if (!config) throw Error('OFFSITE_BACKUP_NOT_CONFIGURED');
  const store = createOffsiteBackupStore(config);
  try {
    if (command === 'list') return await store.list();
    return await store.downloadAndRestore(filename!, destination!, backupKey(env), env.STEWARD_BACKUP_KEY_VERSION ?? 'v1');
  } finally { store.destroy(); }
}

if (import.meta.main) {
  try { console.log(JSON.stringify(await runOffsiteBackup())); }
  catch (error) {
    const code = error instanceof Error && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.message) ? error.message : 'OFFSITE_COMMAND_FAILED';
    console.error(code);
    process.exitCode = 1;
  }
}
