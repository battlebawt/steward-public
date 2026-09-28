import type { Database } from 'bun:sqlite';
import { decryptRecord } from '../crypto';
import { createHash } from 'node:crypto';
export type ScanResult={clean:boolean;engine:string};
export type AttachmentScanner=(bytes:Uint8Array)=>Promise<ScanResult>;
/** Local-only scanner; plaintext is streamed to stdin and never uploaded or written to a temporary file.
 * Options: https://docs.clamav.net/manual/Usage/Scanning.html */
export function clamAvScanner(binary='clamscan'):AttachmentScanner{
 return async bytes=>{
  const version=Bun.spawn([binary,'--version'],{stdout:'pipe',stderr:'ignore'});
  const timer=setTimeout(()=>version.kill(),10000);
  let output:string;
  try{output=await new Response(version.stdout).text();if(await version.exited!==0)throw Error('SCANNER_UNAVAILABLE');}finally{clearTimeout(timer);}
  const fields=output.trim().split('/'),updated=Date.parse(fields.at(-1)??'');
  if(!output.startsWith('ClamAV ')||!Number.isFinite(updated)||Date.now()-updated>48*3600000||updated>Date.now()+300000)throw Error('SCANNER_DEFINITIONS_STALE');
  const process=Bun.spawn([binary,'--no-summary','--max-filesize=10M','--max-scansize=20M','--max-recursion=8','--alert-exceeds-max=yes','--alert-encrypted=yes','--max-scantime=30000','-'],{stdin:new Blob([new Uint8Array(bytes)]),stdout:'ignore',stderr:'ignore'});
  const timeout=setTimeout(()=>process.kill(),45000);
  try{const code=await process.exited;if(code!==0&&code!==1)throw Error('SCANNER_UNAVAILABLE');return {clean:code===0,engine:fields.slice(0,2).join('/').slice(0,120)};}finally{clearTimeout(timeout);}
 };
}
/** A scan applies only to the same immutable encrypted upload and digest; failures leave quarantine intact. */
export async function scanAttachment(db:Database,key:Uint8Array,attachmentId:string,scanner:AttachmentScanner){
 const row=db.query("SELECT id,account_id,storage_key,sha256,state FROM attachments WHERE id=? AND state='quarantined'").get(attachmentId) as {id:string;account_id:string;storage_key:string;sha256:string;state:string}|null;
 if(!row)throw Error('QUARANTINED_ATTACHMENT_REQUIRED');
 const bytes=await decryptRecord(JSON.parse(row.storage_key),key,row.id);
 if(bytes.length>10*1024*1024||createHash('sha256').update(bytes).digest('hex')!==row.sha256)throw Error('ATTACHMENT_INTEGRITY_FAILED');
 const result=await scanner(bytes);
 db.exec('CREATE TABLE IF NOT EXISTS ops_attachment_scans(id TEXT PRIMARY KEY,attachment_id TEXT NOT NULL,digest TEXT NOT NULL,engine TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL)');
 const state=result.clean?'released':'rejected',at=new Date().toISOString();
 db.transaction(()=>{
  const change=db.query("UPDATE attachments SET state=? WHERE id=? AND state='quarantined' AND sha256=? AND storage_key=?").run(state,row.id,row.sha256,row.storage_key);
  if(!change.changes)throw Error('ATTACHMENT_CHANGED');
  db.query('INSERT INTO ops_attachment_scans VALUES (?,?,?,?,?,?)').run(crypto.randomUUID(),row.id,row.sha256,result.engine,state,at);
 })();
 return {attachmentId,state};
}
