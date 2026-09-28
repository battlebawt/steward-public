import {test,expect} from 'bun:test';
import {startMaintenanceWorker} from './maintenance-worker';
test('maintenance isolates failures, throttles backups and prevents overlapping work',async()=>{
 let now=1000,scans=0,backups=0;let unblock:()=>void=()=>{};const held=new Promise<void>(resolve=>{unblock=resolve;});
 const worker=startMaintenanceWorker({intervalMs:100000,now:()=>now,scan:async()=>{scans++;return {failed:1};},backup:async()=>{backups++;await held;throw Error('PRIVATE_KEY_VALUE');}});
 await worker.tick();expect(backups).toBe(1);unblock();
 while(worker.state.running)await Bun.sleep(1);
 expect(worker.state.lastBackupError).toBe('BACKUP_MAINTENANCE_FAILED');expect(scans).toBe(1);
 await worker.tick();expect(backups).toBe(1);expect(scans).toBe(2);
 now+=900000;await worker.tick();expect(backups).toBe(2);expect(worker.state.lastScanError).toBe('SCAN_RETRY_PENDING');
 await worker.stop();await worker.tick();expect(scans).toBe(3);
});

test('backup verification and offsite upload failures emit redacted operator alerts',async()=>{
 let now=0,mode:'verify'|'upload'|'healthy'='verify';
 const alerts:Array<{kind:string;code:string}>=[];
 const worker=startMaintenanceWorker({intervalMs:1000000,backupIntervalMs:1000,now:()=>now,
  scan:async()=>({failed:0}),
  backup:async()=>{if(mode==='upload')throw Error('OFFSITE_UPLOAD_FAILED');return {verificationFailures:mode==='verify'?[{file:'private-name'}]:[]};},
  onAlert:(kind,code)=>alerts.push({kind,code})});
 try{
  while(worker.state.running)await Bun.sleep(1);
  expect(alerts).toEqual([{kind:'backup',code:'BACKUP_VERIFICATION_FAILED'}]);
  now=1000;mode='upload';await worker.tick();
  expect(alerts.at(-1)).toEqual({kind:'backup',code:'OFFSITE_UPLOAD_FAILED'});
  expect(worker.state.lastBackupError).toBe('OFFSITE_UPLOAD_FAILED');
  now=2000;mode='healthy';await worker.tick();
  expect(worker.state.lastBackupError).toBeNull();
  expect(alerts).toHaveLength(2);
 }finally{await worker.stop();}
});
