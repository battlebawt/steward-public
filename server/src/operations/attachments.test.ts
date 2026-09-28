import { test,expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { createDatabase } from '../db';
import { encryptRecord } from '../crypto';
import { scanAttachment } from './attachments';
test('attachment release requires successful scan of exact authenticated bytes; unavailable scanner preserves quarantine',async()=>{
 const db=createDatabase(':memory:'),key=crypto.getRandomValues(new Uint8Array(32)),bytes=new TextEncoder().encode('test fixture'),at=new Date().toISOString();
 try{
 db.query('INSERT INTO users(id,wallet_address,created_at) VALUES (?,?,?)').run('u','0x0000000000000000000000000000000000000001',at);
 db.query('INSERT INTO accounts(id,chain_id,address,parent_user_id,created_at) VALUES (?,?,?,?,?)').run('a',31337,'0x0000000000000000000000000000000000000002','u',at);
 const encrypted=await encryptRecord(bytes,key,'v1','f');
 db.query('INSERT INTO attachments(id,account_id,storage_key,filename_ciphertext,mime_type,size_bytes,sha256,state,created_by_user_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run('f','a',JSON.stringify(encrypted),JSON.stringify(await encryptRecord('fixture.pdf',key,'v1','f:name')),'application/pdf',bytes.length,createHash('sha256').update(bytes).digest('hex'),'quarantined','u',at);
 await expect(scanAttachment(db,key,'f',async()=>{throw Error('offline');})).rejects.toThrow();
 expect(db.query('SELECT state FROM attachments').get()).toEqual({state:'quarantined'});
 expect(await scanAttachment(db,key,'f',async input=>{expect(input).toEqual(bytes);return {clean:true,engine:'test-fixture'};})).toEqual({attachmentId:'f',state:'released'});
 await expect(scanAttachment(db,key,'f',async()=>({clean:true,engine:'test-fixture'}))).rejects.toThrow();
 }finally{db.close();}
});
