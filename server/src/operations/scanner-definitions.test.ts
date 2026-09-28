import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { startScannerDefinitions } from './scanner-definitions';

test('signature updates serialize, redact failures, recover, and stop before database close', async () => {
  const db = new Database(':memory:');
  let calls = 0;
  let release!: () => void;
  const worker = startScannerDefinitions({ db, update: async () => {
    calls++;
    if (calls === 1) { await new Promise<void>(resolve => { release = resolve; }); throw Error('private provider diagnostics'); }
  } });
  try {
    const first = worker.tick();
    const second = worker.tick();
    expect(calls).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(worker.state.lastError).toBe('SCANNER_UPDATE_FAILED');
    expect(JSON.stringify(db.query('SELECT * FROM ops_maintenance_events').all())).not.toContain('private provider');
    await worker.tick();
    expect(calls).toBe(2);
    expect(worker.state.lastError).toBeNull();
    expect(worker.state.lastSuccessAt).not.toBeNull();
    await worker.stop();
    await worker.tick();
    expect(calls).toBe(2);
  } finally { await worker.stop(); db.close(); }
});

test('a stalled updater is aborted with a safe timeout and shutdown cancels an active update', async () => {
  const db = new Database(':memory:');
  let aborted = 0;
  const worker = startScannerDefinitions({ db, timeoutMs: 10, update: signal => new Promise<void>((_, reject) => {
    signal.addEventListener('abort', () => { aborted++; reject(Error('aborted')); }, { once: true });
  }) });
  try {
    await worker.tick();
    expect(worker.state.lastError).toBe('SCANNER_UPDATE_TIMEOUT');
    expect(aborted).toBe(1);
    const pending = worker.tick();
    await worker.stop();
    await pending;
    expect(aborted).toBe(2);
    expect(worker.state.running).toBe(false);
    expect(db.query('SELECT count(*) AS n FROM ops_maintenance_events').get()).toEqual({ n: 1 });
  } finally { await worker.stop(); db.close(); }
});
