import type { Database } from 'bun:sqlite';
import { enqueue } from './jobs';
export type Block = { number: number; hash: string; parentHash: string; timestamp: number };
export type ChainLog = { blockNumber: number; blockHash: string; transactionHash: string; logIndex: number; address: string; topics: string[]; data: string };
export type IndexSource = { block(number: number | 'latest' | 'safe' | 'finalized'): Promise<Block>; logs(from: number, to: number, addresses: string[]): Promise<ChainLog[]> };
/** Reorg rollback reads at most 256 ancestors, so older headers are never read again. */
export const BLOCK_HASH_RETENTION = 1024;
export function initIndexer(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS ops_chain_blocks(chain_id INTEGER NOT NULL,number INTEGER NOT NULL,hash TEXT NOT NULL,parent_hash TEXT NOT NULL,timestamp INTEGER NOT NULL,PRIMARY KEY(chain_id,number));
  CREATE TABLE IF NOT EXISTS ops_chain_logs(chain_id INTEGER NOT NULL,block_number INTEGER NOT NULL,block_hash TEXT NOT NULL,tx_hash TEXT NOT NULL,log_index INTEGER NOT NULL,address TEXT NOT NULL,payload TEXT NOT NULL,canonical INTEGER NOT NULL,finality TEXT NOT NULL,PRIMARY KEY(chain_id,block_hash,tx_hash,log_index));
  CREATE TABLE IF NOT EXISTS ops_index_cursors(chain_id INTEGER PRIMARY KEY,next_block INTEGER NOT NULL,chunk_size INTEGER NOT NULL,last_success INTEGER);
  CREATE TABLE IF NOT EXISTS ops_index_accounts(chain_id INTEGER NOT NULL,address TEXT NOT NULL,account_id TEXT NOT NULL,deployment_block INTEGER NOT NULL,PRIMARY KEY(chain_id,address));`);
}
export function registerIndexAccount(db: Database, chainId: number, address: string, accountId: string, deploymentBlock: number) {
  db.transaction(() => {
    const inserted=db.query('INSERT OR IGNORE INTO ops_index_accounts VALUES (?,?,?,?)').run(chainId, address.toLowerCase(), accountId, deploymentBlock);
    if(!inserted.changes)return;
    db.query('INSERT INTO ops_index_cursors(chain_id,next_block,chunk_size) VALUES (?,?,100) ON CONFLICT(chain_id) DO UPDATE SET next_block=min(next_block,excluded.next_block)').run(chainId, deploymentBlock);
  })();
}
/** Call rebuild inside the same transaction; projections must derive only from canonical logs. */
export async function indexStep(db: Database, chainId: number, source: IndexSource, rebuild: () => void = () => {}) {
  const cursor = db.query('SELECT * FROM ops_index_cursors WHERE chain_id=?').get(chainId) as { next_block: number; chunk_size: number } | null;
  if (!cursor) return { processed: 0, state: 'idle', behind: false };
  const accounts = db.query('SELECT * FROM ops_index_accounts WHERE chain_id=?').all(chainId) as {address: string; account_id: string; deployment_block: number}[];
  const earliest = Math.min(...accounts.map(a => a.deployment_block));
  let from = cursor.next_block;
  const previous = db.query('SELECT * FROM ops_chain_blocks WHERE chain_id=? AND number=?').get(chainId, from - 1) as {hash: string} | null;
  if (previous && (await source.block(from - 1)).hash.toLowerCase() !== previous.hash.toLowerCase()) {
    let ancestor = from - 2;
    // Bounded rollback; deep reorg requires operator intervention rather than skipping history.
    for (let scanned = 0; ancestor >= earliest; ancestor--, scanned++) {
      if (scanned >= 256) throw new Error('DEEP_REORG_REQUIRES_REVIEW');
      const saved = db.query('SELECT hash FROM ops_chain_blocks WHERE chain_id=? AND number=?').get(chainId, ancestor) as {hash: string} | null;
      if (saved && saved.hash.toLowerCase() === (await source.block(ancestor)).hash.toLowerCase()) break;
    }
    from = ancestor + 1;
    db.transaction(() => {
      const orphaned = db.query('SELECT DISTINCT address,tx_hash,finality FROM ops_chain_logs WHERE chain_id=? AND block_number>=? AND canonical=1').all(chainId, from) as { address: string; tx_hash: string; finality: string }[];
      for (const log of orphaned) {
        const account = accounts.find(a => a.address === log.address);
        if (account) enqueue(db, { accountId: account.account_id, kind: log.finality === 'finalized' ? 'FINALITY_ANOMALY' : 'REORG_CORRECTION', dedupeKey: `reorg:${chainId}:${log.tx_hash}:${from}`, payload: { resourceId: log.tx_hash } });
      }
      db.query('UPDATE ops_chain_logs SET canonical=0 WHERE chain_id=? AND block_number>=?').run(chainId, from);
      db.query('DELETE FROM ops_chain_blocks WHERE chain_id=? AND number>=?').run(chainId, from);
      db.query('UPDATE ops_index_cursors SET next_block=? WHERE chain_id=?').run(from, chainId);
      rebuild();
    })();
  }
  const head = await source.block('latest');
  // Unsupported safe/finalized tags leave state 'included'; no invented confirmation count.
  const finality = await Promise.allSettled([source.block('safe'), source.block('finalized')]);
  const safe = finality[0].status === 'fulfilled' ? finality[0].value.number : -1;
  const finalized = finality[1].status === 'fulfilled' ? finality[1].value.number : -1;
  for (const result of finality) {
    if (result.status === 'fulfilled' && ((await source.block(result.value.number)).hash !== result.value.hash || result.value.number > head.number)) throw new Error('FINALITY_DISAGREEMENT');
  }
  if (from > head.number) {
    db.transaction(() => {
      db.query("UPDATE ops_chain_logs SET finality=CASE WHEN block_number<=? THEN 'finalized' WHEN block_number<=? THEN 'safe' ELSE finality END WHERE chain_id=? AND canonical=1").run(finalized, safe, chainId);
      rebuild();
    })();
    return { processed: 0, state: 'caught_up', behind: false };
  }
  const to = Math.min(head.number, from + cursor.chunk_size - 1);
  let logs: ChainLog[];
  try { logs = await source.logs(from, to, accounts.map(a => a.address)); }
  catch { db.query('UPDATE ops_index_cursors SET chunk_size=? WHERE chain_id=?').run(Math.max(1, Math.floor(cursor.chunk_size / 2)), chainId); throw new Error('INDEX_RANGE_UNAVAILABLE'); }
  const blocks: Block[] = [];
  for (let n = from; n <= to; n++) {
    const block = await source.block(n);
    if (block.number !== n || (blocks.length && block.parentHash !== blocks[blocks.length - 1]!.hash)) throw new Error('CHAIN_CHANGED_DURING_SCAN');
    blocks.push(block);
  }
  if (from > earliest) {
    const parent = db.query('SELECT hash FROM ops_chain_blocks WHERE chain_id=? AND number=?').get(chainId, from - 1) as {hash: string} | null;
    if (parent && parent.hash !== blocks[0]!.parentHash) throw new Error('CHAIN_CHANGED_DURING_SCAN');
  }
  if (logs.some(l => l.blockNumber < from || l.blockNumber > to || blocks[l.blockNumber - from]!.hash !== l.blockHash || !accounts.some(a => a.address === l.address.toLowerCase()))) throw new Error('INVALID_LOG_RANGE');
  if ((await source.block(to)).hash !== blocks[blocks.length - 1]!.hash) throw new Error('CHAIN_CHANGED_DURING_SCAN');
  db.transaction(() => {
    for (const b of blocks) db.query('INSERT OR REPLACE INTO ops_chain_blocks VALUES (?,?,?,?,?)').run(chainId, b.number, b.hash, b.parentHash, b.timestamp);
    db.query('DELETE FROM ops_chain_blocks WHERE chain_id=? AND number<?').run(chainId, to + 1 - BLOCK_HASH_RETENTION);
    for (const l of logs) db.query('INSERT OR REPLACE INTO ops_chain_logs VALUES (?,?,?,?,?,?,?,?,?)').run(chainId, l.blockNumber, l.blockHash, l.transactionHash, l.logIndex, l.address.toLowerCase(), JSON.stringify(l), 1, l.blockNumber <= finalized ? 'finalized' : l.blockNumber <= safe ? 'safe' : 'included');
    db.query("UPDATE ops_chain_logs SET finality=CASE WHEN block_number<=? THEN 'finalized' WHEN block_number<=? THEN 'safe' ELSE finality END WHERE chain_id=? AND canonical=1").run(finalized, safe, chainId);
    db.query('UPDATE ops_index_cursors SET next_block=?,chunk_size=?,last_success=? WHERE chain_id=?').run(to + 1, Math.min(100, cursor.chunk_size + 1), Date.now(), chainId);
    rebuild();
  })();
  return { processed: to - from + 1, state: 'indexed', behind: to < head.number };
}
