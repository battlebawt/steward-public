/** Builds and exercises a disposable local image. No hosting account or real secrets. */
import {execFileSync} from 'node:child_process';
const suffix=crypto.randomUUID().slice(0,8),tag=`steward-rehearsal:${suffix}`,name=`steward-rehearsal-${suffix}`,publicName=`${name}-public`;
const scannerCheck=process.argv.includes('--scanner');
const docker=(args:string[])=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:300000});
let built=false,started=false,publicStarted=false;
try{
 docker(['build','-t',tag,'.']);built=true;
 if(docker(['run','--rm',tag,'id','-u']).trim()==='0')throw Error('CONTAINER_MUST_NOT_RUN_AS_ROOT');
 docker(['run','--detach','--name',name,'--env','STEWARD_MODE=demo','--env','ORIGIN=http://localhost:3000','--env','DATABASE_PATH=/app/data/smoke.sqlite',tag]);started=true;
 let healthy=false;
 for(let attempt=0;attempt<30;attempt++){
  try{docker(['exec',name,'bun','-e',"const r=await fetch('http://127.0.0.1:3000/api/v1/health/ready');const b=await r.json();if(!r.ok||b.data.mode!=='demo')process.exit(1)"]);healthy=true;break;}catch{await Bun.sleep(200);}
 }
 if(!healthy)throw Error('CONTAINER_NOT_READY');
 docker(['exec',name,'bun','-e',"const r=await fetch('http://127.0.0.1:3000/');if(!r.ok||!(await r.text()).includes('<html'))process.exit(1)"]);
 docker(['exec',name,'bun','scripts/maintenance.ts','status','/app/data/smoke.sqlite']);
 docker(['exec',name,'/usr/bin/freshclam','--version']);
 docker(['exec',name,'sh','-c','test -x /app/scripts/clamscan.sh && test -r /app/config/freshclam.conf']);
 if(scannerCheck){
  docker(['exec',name,'bun','scripts/scanner-smoke.ts']);
 }
 // Generate all encryption keys in the disposable container. They are never printed.
 docker(['exec',name,'bun','-e',`const key=Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
 const env={...process.env,STEWARD_BACKUP_KEY:key};
 for(const args of [['backup','/app/data/smoke.sqlite','/app/backups'],['verify','/app/backups']]){
  const p=Bun.spawn(['bun','scripts/maintenance.ts',...args],{env,stdout:'pipe',stderr:'pipe'});
  const output=await new Response(p.stdout).text();if(await p.exited!==0)throw Error('PACKAGED_MAINTENANCE_FAILED');
  const result=JSON.parse(output);if(result.verificationFailures?.length||result.failures?.length)throw Error('PACKAGED_BACKUP_VERIFY_FAILED');
 }
 const {readdir}=await import('node:fs/promises');const file=(await readdir('/app/backups')).find(n=>n.endsWith('.enc'));
 const p=Bun.spawn(['bun','scripts/backup.ts','restore','/app/backups/'+file,'/app/data/restored.sqlite'],{env,stdout:'pipe',stderr:'pipe'});
 if(await p.exited!==0)throw Error('PACKAGED_RESTORE_FAILED');`]);
 docker(['run','--detach','--name',publicName,'--env','STEWARD_MODE=demo','--env','STEWARD_PUBLIC_DEMO=true','--env','ORIGIN=https://demo.example.test','--env','DATABASE_PATH=:memory:',tag]);publicStarted=true;
 const ip=docker(['inspect','--format','{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',publicName]).trim();
 if(!ip)throw Error('PUBLIC_DEMO_CONTAINER_IP_UNAVAILABLE');
 let publicReady=false;
 for(let attempt=0;attempt<30;attempt++){
  try{docker(['exec',publicName,'bun','-e',`const r=await fetch('http://${ip}:3000/api/v1/health/ready');const b=await r.json();if(!r.ok||b.data.mode!=='demo')process.exit(1)`]);publicReady=true;break;}catch{await Bun.sleep(200);}
 }
 if(!publicReady)throw Error('PUBLIC_DEMO_NOT_REACHABLE_OUTSIDE_LOOPBACK');
 docker(['exec',publicName,'bun','-e',`const url='http://${ip}:3000/api/v1/auth/demo';const r=await fetch(url,{method:'POST',headers:{host:'demo.example.test',origin:'https://demo.example.test','content-type':'application/json'},body:JSON.stringify({chainId:31337})});if(!r.ok||!r.headers.get('set-cookie')?.includes('Secure'))process.exit(1);const account=(await r.json()).data.account.id;const upload=await fetch('http://${ip}:3000/api/v1/accounts/'+account+'/attachments',{method:'POST',headers:{host:'demo.example.test',origin:'https://demo.example.test',cookie:r.headers.get('set-cookie').split(';')[0]}});if(upload.status!==403||(await upload.json()).error.code!=='DEMO_UPLOADS_DISABLED')process.exit(1)`]);
 console.log(JSON.stringify({status:'passed',checks:11+(scannerCheck?3:0),scope:'disposable non-root image, local demo health/static files, packaged maintenance/scanner, encrypted backup verify/restore, hosted demo external bind/secure session/upload rejection',scannerDefinitionsAndFixtures:scannerCheck?'passed':'not-requested',publicDeployment:false}));
}finally{
 if(publicStarted)docker(['rm','--force',publicName]);
 if(started)docker(['rm','--force',name]);
 if(built)docker(['image','rm',tag]);
}
