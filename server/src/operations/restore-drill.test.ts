import {test,expect} from 'bun:test';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDatabase} from '../db';
import {encryptRecord,decryptRecord,sha256} from '../crypto';
import {backupDatabase,restoreDatabase} from './backup';
import {initOperations,enqueue} from './jobs';
import {initIndexer,registerIndexAccount} from './indexer';
test('restored application preserves encrypted documents, grants, and pending work while requiring a separate service key',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'steward-restore-drill-')),backupKey=randomBytes(32),serviceKey=randomBytes(32),now=new Date().toISOString();
 const db=createDatabase(':memory:');let restored:ReturnType<typeof createDatabase>|undefined;
 try{
  initOperations(db);initIndexer(db);
  db.query('INSERT INTO users(id,wallet_address,created_at) VALUES(?,?,?)').run('parent','0x0000000000000000000000000000000000000001',now);
  db.query('INSERT INTO accounts(id,chain_id,address,parent_user_id,created_at) VALUES(?,?,?,?,?)').run('a',31337,'0x0000000000000000000000000000000000000002','parent',now);
  db.query('INSERT INTO account_grants(id,account_id,user_id,role,scopes_json,created_at) VALUES(?,?,?,?,?,?)').run('grant','a','parent','viewer','["portfolio.view"]',now);
  const plain='synthetic private test document';
  db.query('INSERT INTO attachments(id,account_id,storage_key,filename_ciphertext,mime_type,size_bytes,sha256,state,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run('f','a',JSON.stringify(await encryptRecord(plain,serviceKey,'v1','f')),JSON.stringify(await encryptRecord('fixture.pdf',serviceKey,'v1','f:name')),'application/pdf',plain.length,sha256(plain),'quarantined','parent',now);
  enqueue(db,{accountId:'a',kind:'continuity.requested',dedupeKey:'case1',payload:{resourceId:'c1'}});registerIndexAccount(db,31337,'0x0000000000000000000000000000000000000002','a',100);
  await backupDatabase(db,join(dir,'snapshot.enc'),backupKey,'test');await restoreDatabase(join(dir,'snapshot.enc'),join(dir,'restored.sqlite'),backupKey);
  restored=createDatabase(join(dir,'restored.sqlite'));
  const row=restored.query('SELECT storage_key,state FROM attachments').get() as any;
  await expect(decryptRecord(JSON.parse(row.storage_key),backupKey,'f')).rejects.toThrow();
  expect(new TextDecoder().decode(await decryptRecord(JSON.parse(row.storage_key),serviceKey,'f'))).toBe(plain);expect(row.state).toBe('quarantined');
  expect(restored.query('SELECT scopes_json FROM account_grants').get()).toEqual({scopes_json:'["portfolio.view"]'});
  expect(restored.query('SELECT status,attempts FROM ops_outbox').get()).toEqual({status:'pending',attempts:0});
  expect(restored.query('SELECT next_block FROM ops_index_cursors').get()).toEqual({next_block:100});
 }finally{restored?.close();db.close();await rm(dir,{recursive:true,force:true});}
});
