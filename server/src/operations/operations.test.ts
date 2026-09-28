import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { initOperations, enqueue, claim, runOne, emailChannel, recordDelivered } from './jobs';
import { initIndexer, registerIndexAccount, indexStep, BLOCK_HASH_RETENTION, type IndexSource, type Block } from './indexer';
import { backupDatabase, restoreDatabase } from './backup';
const db = () => { const d = new Database(':memory:'); initOperations(d); return d; };
describe('durable operations', () => {
  test('enqueue is idempotent and transaction rollback leaves no orphan notification', () => {
    const d = db(); const input = { accountId: 'a', kind: 'review', dedupeKey: 'event-1', payload: {resourceId: 'x'} };
    expect(enqueue(d, input, 1)).toBe(enqueue(d, input, 2));
    expect(() => d.transaction(() => { enqueue(d, {...input,dedupeKey:'event-2'},3); throw Error(); })()).toThrow();
    expect(d.query('SELECT count(*) AS n FROM ops_outbox').get()).toEqual({n:1}); d.close();
  });
  test('exclusive leases, recovery, exhaustion and stale-worker protection', async () => {
    const d = db(); enqueue(d,{accountId:'a',kind:'review',dedupeKey:'1',payload:{resourceId:'x'}},0);
    expect(claim(d,'one',0,10,2)?.attempts).toBe(1); expect(claim(d,'two',1,10,2)).toBeNull();
    expect(claim(d,'two',11,10,2)?.attempts).toBe(2); expect(claim(d,'three',22,10,2)).toBeNull();
    expect(d.query('SELECT status FROM ops_outbox').get()).toEqual({status:'dead'}); d.close();
  });
  test('email acceptance is not delivery; bounded retries preserve idempotency', async () => {
    const d=db(); enqueue(d,{accountId:'a',kind:'review',dedupeKey:'1',payload:{resourceId:'x'}},0);
    await runOne(d,'a',async()=>{throw new Error('secret remote URL');},0);
    expect(d.query('SELECT status,last_error FROM ops_outbox').get()).toEqual({status:'pending',last_error:'DELIVERY_FAILED'});
    await runOne(d,'a',emailChannel(async input=>{expect(input.text).not.toContain('x');return {id:'provider-1'};}),3000);
    expect(d.query('SELECT status FROM ops_outbox').get()).toEqual({status:'accepted'});
    recordDelivered(d,'provider-1'); expect(d.query('SELECT status FROM ops_outbox').get()).toEqual({status:'delivered'});d.close();
  });
  test('encrypted snapshot restores records; wrong key and overwrite fail', async () => {
    const d = db(), dir = await mkdtemp(join(tmpdir(),'steward-backup-')), key=randomBytes(32);
    try {
      enqueue(d,{accountId:'a',kind:'review',dedupeKey:'1',payload:{resourceId:'x'}});
      await backupDatabase(d,join(dir,'backup.enc'),key,'v1');
      await expect(restoreDatabase(join(dir,'backup.enc'),join(dir,'wrong.db'),randomBytes(32))).rejects.toThrow();
      await restoreDatabase(join(dir,'backup.enc'),join(dir,'restored.db'),key);
      const restored=new Database(join(dir,'restored.db')); expect(restored.query('SELECT count(*) AS n FROM ops_outbox').get()).toEqual({n:1}); restored.close();
      await expect(restoreDatabase(join(dir,'backup.enc'),join(dir,'restored.db'),key)).rejects.toThrow();
    } finally { d.close(); await rm(dir,{recursive:true,force:true}); }
  });
  test('registering an existing account does not rewind a healthy cursor',()=>{
    const d=db();initIndexer(d);registerIndexAccount(d,31337,'0xabc','a',1);
    d.query('UPDATE ops_index_cursors SET next_block=100').run();
    registerIndexAccount(d,31337,'0xabc','a',1);
    expect(d.query('SELECT next_block FROM ops_index_cursors').get()).toEqual({next_block:100});
    registerIndexAccount(d,31337,'0xdef','b',50);
    expect(d.query('SELECT next_block FROM ops_index_cursors').get()).toEqual({next_block:50});d.close();
  });
  test('indexer rewinds orphaned logs, issues correction and never skips failed ranges', async () => {
    const d=db();initIndexer(d);registerIndexAccount(d,31337,'0xabc','a',1);
    let fork=false, fail=false;
    const block=(n:number):Block=>({number:n,hash:`${fork&&n>=2?'b':'a'}${n}`,parentHash:n===2?'a1':`${fork&&n>2?'b':'a'}${n-1}`,timestamp:n});
    const source:IndexSource={block:async n=>block(typeof n==='number'?n:n==='latest'?3:1),logs:async(from,to)=>{if(fail)throw Error('429');return Array.from({length:to-from+1},(_,i)=>{const b=block(from+i);return {blockNumber:b.number,blockHash:b.hash,transactionHash:`tx-${b.hash}`,logIndex:0,address:'0xabc',topics:[],data:'0x'};});}};
    await indexStep(d,31337,source);fork=true;await indexStep(d,31337,source);
    expect(d.query('SELECT count(*) AS n FROM ops_chain_logs WHERE canonical=0').get()).toEqual({n:2});
    expect(d.query('SELECT count(*) AS n FROM ops_outbox').get()).toEqual({n:2});
    registerIndexAccount(d,31337,'0xdef','b',1);fail=true;
    await expect(indexStep(d,31337,source)).rejects.toThrow('INDEX_RANGE_UNAVAILABLE');
    expect(d.query('SELECT next_block,chunk_size FROM ops_index_cursors').get()).toEqual({next_block:1,chunk_size:50});d.close();
  });
});

test('duplicate delivery proofs are idempotent and permanent failure overrides delivered state',async()=>{
  const {recordDeliveryFailure}=await import('./jobs');const d=db();enqueue(d,{accountId:'a',kind:'review',dedupeKey:'1',payload:{resourceId:'x'}},0);
  await runOne(d,'worker',emailChannel(async()=>({id:'email1'})),1);
  recordDelivered(d,'email1',2);recordDelivered(d,'email1',3);
  expect(d.query("SELECT count(*) n FROM ops_delivery_attempts WHERE status='delivered'").get()).toEqual({n:1});
  recordDeliveryFailure(d,'email1',4);recordDelivered(d,'email1',5);
  expect(d.query('SELECT status,last_error FROM ops_outbox').get()).toEqual({status:'dead',last_error:'PROVIDER_DELIVERY_FAILED'});d.close();
});

test('indexer keeps only the recent block hashes that reorg checks can read',async()=>{
  const d=db();initIndexer(d);registerIndexAccount(d,31337,'0xabc','a',1);
  const head=BLOCK_HASH_RETENTION+300;
  const block=(n:number):Block=>({number:n,hash:`h${n}`,parentHash:`h${n-1}`,timestamp:n});
  const source:IndexSource={block:async n=>block(typeof n==='number'?n:head),logs:async()=>[]};
  for(let i=0;i<200;i++)if((await indexStep(d,31337,source)).state==='caught_up')break;
  expect(d.query('SELECT next_block FROM ops_index_cursors').get()).toEqual({next_block:head+1});
  expect(d.query('SELECT count(*) AS n,min(number) AS low,max(number) AS high FROM ops_chain_blocks').get()).toEqual({n:BLOCK_HASH_RETENTION,low:head-BLOCK_HASH_RETENTION+1,high:head});
  d.close();
});
