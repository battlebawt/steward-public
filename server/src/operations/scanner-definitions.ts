import type { Database } from 'bun:sqlite';
import { mkdir } from 'node:fs/promises';

const UPDATE_INTERVAL_MS = 2 * 60 * 60 * 1000;
const UPDATE_TIMEOUT_MS = 120_000;

/** Only official signatures are downloaded. No documents or service keys enter this process. */
async function updateDefinitions(signal: AbortSignal) {
  await mkdir('/app/data/clamav', { recursive: true, mode: 0o700 });
  signal.throwIfAborted();
  const child = Bun.spawn(['/usr/bin/freshclam', '--config-file=/app/config/freshclam.conf', '--stdout'], {
    // The updater does not need the app's credentials or encryption keys.
    env: {},
    stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
  });
  const abort = () => child.kill('SIGKILL');
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    const exit = await child.exited;
    signal.throwIfAborted();
    if (exit !== 0) throw Error('SCANNER_UPDATE_FAILED');
  } finally { signal.removeEventListener('abort', abort); }
}

/** Opt-in, independent of backup and notification work. Scans still enforce signature freshness. */
export function startScannerDefinitions(options: {
  db: Database;
  update?: (signal: AbortSignal) => Promise<void>;
  intervalMs?: number;
  timeoutMs?: number;
}) {
  const { db } = options;
  db.exec(`CREATE TABLE IF NOT EXISTS ops_maintenance_events(
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, target_id TEXT, status TEXT NOT NULL,
    safe_code TEXT, created_at TEXT NOT NULL
  )`);
  const state: { running: boolean; lastSuccessAt: string | null; lastError: string | null } = {
    running: false, lastSuccessAt: null, lastError: null,
  };
  let stopped = false;
  let pending: Promise<void> | undefined;
  let active: AbortController | undefined;
  const tick = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (pending) return pending;
    active = new AbortController();
    const controller = active;
    state.running = true;
    pending = (async () => {
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs ?? UPDATE_TIMEOUT_MS);
      try {
        await (options.update ?? updateDefinitions)(controller.signal);
        controller.signal.throwIfAborted();
        state.lastSuccessAt = new Date().toISOString();
        state.lastError = null;
        db.query('INSERT INTO ops_maintenance_events VALUES (?,?,?,?,?,?)')
          .run(crypto.randomUUID(), 'scanner_definitions', null, 'completed', null, state.lastSuccessAt);
      } catch {
        if (!stopped) {
          state.lastError = timedOut ? 'SCANNER_UPDATE_TIMEOUT' : 'SCANNER_UPDATE_FAILED';
          db.query('INSERT INTO ops_maintenance_events VALUES (?,?,?,?,?,?)')
            .run(crypto.randomUUID(), 'scanner_definitions', null, 'failed', state.lastError, new Date().toISOString());
        }
      } finally {
        clearTimeout(timer);
        state.running = false;
        pending = undefined;
        active = undefined;
      }
    })();
    return pending;
  };
  const timer = setInterval(() => { void tick(); }, options.intervalMs ?? UPDATE_INTERVAL_MS);
  timer.unref();
  void tick();
  return {
    state, tick,
    stop: async () => { stopped = true; clearInterval(timer); active?.abort(); await pending; },
  };
}
