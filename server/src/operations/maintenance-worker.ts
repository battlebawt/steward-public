/** Opt-in in-process maintenance; the caller owns backup destination and scanner setup. */
export function startMaintenanceWorker(options:{scan:()=>Promise<{failed:number}>;backup:()=>Promise<{verificationFailures:unknown[]}>;onAlert?:(kind:'backup'|'scan',code:string)=>void;now?:()=>number;intervalMs?:number;backupIntervalMs?:number}){
 const now=options.now??Date.now;let stopped=false,busy=false,lastBackupAttempt:number|null=null;
 const state:{running:boolean;lastScanAt:number|null;lastBackupAt:number|null;lastScanError:string|null;lastBackupError:string|null}={running:false,lastScanAt:null,lastBackupAt:null,lastScanError:null,lastBackupError:null};
 const alert=(kind:'backup'|'scan',code:string)=>{try{options.onAlert?.(kind,code);}catch{/* alerting must not suppress the next maintenance attempt */}};
 const backupCodes=new Set(['OFFSITE_UPLOAD_FAILED','BACKUP_DIRECTORY_SIZE_LIMIT','BACKUP_DIRECTORY_FILE_LIMIT','BACKUP_SIZE_LIMIT','BACKUP_KEY_VERSION_MISMATCH','BACKUP_AUTH_FAILED','BACKUP_INVALID_SQLITE','BACKUP_INTEGRITY_FAILED']);
 const safeCode=(error:unknown)=>error instanceof Error&&backupCodes.has(error.message)?error.message:'BACKUP_MAINTENANCE_FAILED';
 const tick=async()=>{
  if(stopped||busy)return;busy=true;state.running=true;
  try{
   // A broken scanner must not suppress snapshots, or the reverse.
   if(lastBackupAttempt===null||now()-lastBackupAttempt>=(options.backupIntervalMs??900_000)){
    lastBackupAttempt=now();try{const result=await options.backup();state.lastBackupError=result.verificationFailures.length?'BACKUP_VERIFICATION_FAILED':null;if(state.lastBackupError)alert('backup',state.lastBackupError);else state.lastBackupAt=now();}catch(error){state.lastBackupError=safeCode(error);alert('backup',state.lastBackupError);}
   }
   try{const result=await options.scan();state.lastScanError=result.failed?'SCAN_RETRY_PENDING':null;if(state.lastScanError)alert('scan',state.lastScanError);else state.lastScanAt=now();}catch{state.lastScanError='SCAN_RETRY_PENDING';alert('scan',state.lastScanError);}
  }finally{busy=false;state.running=false;}
 };
 const timer=setInterval(()=>void tick(),options.intervalMs??60_000);timer.unref();void tick();
 return {state,tick,stop:async()=>{stopped=true;clearInterval(timer);while(busy)await new Promise(resolve=>setTimeout(resolve,20));}};
}
