import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initOperations, enqueue } from './jobs';
import { initIndexer, registerIndexAccount, type Block, type IndexSource } from './indexer';
import { stagingIndexIntervalMs, startOperations } from './runtime';

const block = (n: number): Block => ({ number: n, hash: `h${n}`, parentHash: `h${n - 1}`, timestamp: n });
const database = () => { const db = new Database(':memory:'); initOperations(db); initIndexer(db); registerIndexAccount(db, 1, '0xabc', 'family', 1); return db; };
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await Bun.sleep(1); }
  throw Error('TEST_WORKER_TIMEOUT');
}

test('only staging can select a bounded slower index cadence', () => {
  expect(stagingIndexIntervalMs(undefined, true)).toBe(60_000);
  expect(stagingIndexIntervalMs('30000', true)).toBe(30_000);
  expect(stagingIndexIntervalMs(undefined, false)).toBeUndefined();
  expect(() => stagingIndexIntervalMs('60000', false)).toThrow('STAGING_INDEX_INTERVAL_REQUIRES_STAGING');
  for (const value of ['0', '5000', '300001', 'nonsense']) expect(() => stagingIndexIntervalMs(value, true)).toThrow('INVALID_STAGING_INDEX_INTERVAL');
});

test('idle cadence delays RPC, while catch-up scans contiguous bounded chunks', async () => {
  const db = database(); let now = 0, head = 220, requests = 0;
  const ranges: Array<[number, number]> = [];
  const source: IndexSource = { block: async tag => { requests++; return block(typeof tag === 'number' ? tag : tag === 'latest' ? head : 1); }, logs: async (from, to) => { requests++; ranges.push([from, to]); return []; } };
  const worker = startOperations({ db, chainId: 1, source, intervalMs: 100_000, indexIntervalMs: 60_000, now: () => now });
  try {
    await until(() => ranges.length === 1);
    expect(ranges).toEqual([[1, 100]]);
    const firstRequests = requests;
    expect(firstRequests).toBeLessThanOrEqual(110);
    now = 14_999; await worker.indexTick(); expect(ranges).toHaveLength(1); expect(requests).toBe(firstRequests);
    now = 15_000; await worker.indexTick(); expect(ranges).toEqual([[1, 100], [101, 200]]);
    now = 30_000; await worker.indexTick(); expect(ranges).toEqual([[1, 100], [101, 200], [201, 220]]);
    expect(db.query('SELECT next_block FROM ops_index_cursors').get()).toEqual({ next_block: 221 });
    expect(db.query('SELECT count(*) AS n,min(number) AS low,max(number) AS high FROM ops_chain_blocks').get()).toEqual({ n: 220, low: 1, high: 220 });
    head = 221; now = 89_999; await worker.indexTick(); expect(ranges).toHaveLength(3);
    now = 90_000; await worker.indexTick(); expect(ranges.at(-1)).toEqual([221, 221]);
    const beforeIdle = requests;
    now = 150_000; await worker.indexTick(); expect(requests - beforeIdle).toBeLessThanOrEqual(6);
    const afterIdle = requests;
    now = 209_999; await worker.indexTick(); expect(requests).toBe(afterIdle);
  } finally { await worker.stop(); db.close(); }
});

test('RPC failures back off without suppressing family notifications', async () => {
  const db = database(); let now = 0, attempts = 0;
  const source: IndexSource = { block: async tag => { if (tag === 'latest' && ++attempts <= 2) throw Error('provider down'); return block(1); }, logs: async () => [] };
  const worker = startOperations({ db, chainId: 1, source, intervalMs: 100_000, indexIntervalMs: 60_000, now: () => now });
  try {
    await until(() => attempts === 1);
    enqueue(db, { accountId: 'family', kind: 'recovery.started', dedupeKey: 'cost-test', payload: { resourceId: 'case1' } });
    await worker.deliveryTick();
    expect(db.query('SELECT status FROM ops_outbox').get()).toEqual({ status: 'delivered' });
    expect(worker.state.lastError).toBe('INDEXER_RETRY_PENDING');
    now = 59_999; await worker.indexTick(); expect(attempts).toBe(1);
    now = 60_000; await worker.indexTick(); expect(attempts).toBe(2);
    now = 179_999; await worker.indexTick(); expect(attempts).toBe(2);
    now = 180_000; await worker.indexTick(); expect(attempts).toBeGreaterThan(2);
    expect(worker.state.lastError).toBeNull();
    expect(db.query('SELECT next_block FROM ops_index_cursors').get()).toEqual({ next_block: 2 });
  } finally { await worker.stop(); db.close(); }
});

test('slow index RPC cannot delay the notification loop', async () => {
  const db = database(); let release!: (value: Block) => void;
  const pending = new Promise<Block>(resolve => { release = resolve; });
  let waiting = false;
  const source: IndexSource = { block: async tag => { if (tag === 'latest') { waiting = true; return pending; } return block(1); }, logs: async () => [] };
  const worker = startOperations({ db, chainId: 1, source, intervalMs: 100_000, indexIntervalMs: 60_000 });
  try {
    await until(() => waiting);
    enqueue(db, { accountId: 'family', kind: 'review', dedupeKey: 'slow-rpc', payload: { resourceId: 'case2' } });
    await worker.deliveryTick();
    expect(db.query('SELECT status FROM ops_outbox').get()).toEqual({ status: 'delivered' });
  } finally { release(block(1)); await worker.stop(); db.close(); }
});
