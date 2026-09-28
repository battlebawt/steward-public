import { test,expect } from 'bun:test';
import { createRuntime } from '../index';
import { VerifiedLiveChainGateway } from '../integrations/live-chain';
test('local runtime is explicitly demo, same-origin protected, and ready with private cache headers',async()=>{
  const runtime=await createRuntime({STEWARD_MODE:'demo',ORIGIN:'http://localhost:5173',DATABASE_PATH:':memory:'});
  try {
    const health=await runtime.app.request('http://localhost/api/v1/health/ready');
    expect(health.status).toBe(200);expect((await health.json()).data.mode).toBe('demo');
    expect(health.headers.get('Cache-Control')).toBe('no-store');expect(health.headers.get('Content-Security-Policy')).toContain("object-src 'none'");
    const denied=await runtime.app.request('http://localhost/api/v1/auth/demo',{method:'POST',headers:{Origin:'https://attacker.invalid','Content-Type':'application/json'},body:'{}'});
    expect(denied.status).toBe(403);
  }finally{await runtime.close();}
});
test('non-loopback demo origin and unconfigured live startup are rejected',async()=>{
 await expect(createRuntime({STEWARD_MODE:'demo',ORIGIN:'https://public.invalid',DATABASE_PATH:':memory:'})).rejects.toThrow('loopback');
 await expect(createRuntime({STEWARD_MODE:'live',ORIGIN:'https://steward.invalid',DATABASE_PATH:':memory:'})).rejects.toThrow('STEWARD_SERVICE_KEY');
});
test('live runtime wires configured admission evidence and leaves missing sources disabled',async()=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {randomBytes}=await import('node:crypto');
 const directory=await mkdtemp(join(tmpdir(),'steward-admission-test-'));
 const address=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as `0x${string}`;
 const manifest=join(directory,'manifest.json');
 await writeFile(manifest,JSON.stringify({chainId:4663,version:'fixture',accounts:[],routes:[]}));
 const base={STEWARD_MODE:'live',ORIGIN:'https://steward.invalid',DATABASE_PATH:':memory:',STEWARD_SERVICE_KEY:randomBytes(32).toString('base64'),STEWARD_MANIFEST_PATH:manifest,STEWARD_RPC_URL:'http://127.0.0.1:1'};
 let runtime:Awaited<ReturnType<typeof createRuntime>>|undefined;
 try{
  runtime=await createRuntime(base);
  expect((runtime.chain as VerifiedLiveChainGateway).options.marketGate).toBeUndefined();
  await runtime.close();runtime=undefined;
  await expect(createRuntime({...base,STEWARD_ADMISSION_ELIGIBILITY_URL:'https://review.example.invalid/eligibility'})).rejects.toThrow('COMPLETE_ADMISSION_SOURCE_CONFIG_REQUIRED');
  const input={account:address(1),actor:address(2),asset:address(3),side:'SELL' as const,chainId:4663,policyVersion:'7',session:'market' as const};
  let requests=0;
  const fetcher=(async(url:URL|RequestInfo,init?:RequestInit)=>{
   requests++;
   const received=JSON.parse(String(init?.body));
   expect({...received,side:'SELL'}).toEqual(input);
   const now=Date.now();
   const common={chainId:4663,asset:input.asset,source:'fixture',observedAt:now-1000,expiresAt:now+10000};
   const body=String(url).endsWith('/eligibility')?{...common,account:input.account,actor:input.actor,side:received.side,policyVersion:'7',status:'allowed',evidence:'fixture'}:{...common,session:'market',state:'open',halted:false};
   return new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
  }) as typeof fetch;
  const catalog={assets:async()=>[{id:'fixture',provider:'robinhood' as const,chainId:4663,address:input.asset,symbol:'FIX',name:'Fixture',decimals:6,multiplier:'1',sessions:{market:'closing_only' as const,extended:'unknown' as const,overnight:'unknown' as const},active:true,eligibility:'review-required' as const,termsUrl:'https://example.invalid',raw:{}}]};
  runtime=await createRuntime({...base,STEWARD_ADMISSION_ELIGIBILITY_URL:'https://review.example.invalid/eligibility',STEWARD_ADMISSION_MARKET_URL:'https://market.example.invalid/session',STEWARD_ADMISSION_API_KEY:'fixture-key'},{admissionFetch:fetcher,catalog});
  const gate=(runtime.chain as VerifiedLiveChainGateway).options.marketGate;
  expect(gate).toBeDefined();
  expect((await gate!(input)).allowed).toBe(true);
  expect((await gate!({...input,side:'BUY'})).allowed).toBe(false);
  expect(requests).toBe(4);
 }finally{await runtime?.close();await rm(directory,{recursive:true,force:true});}
});
test('opt-in hosted demo requires HTTPS and memory, uses secure sessions, and refuses files',async()=>{
 const origin='https://demo.example.test',body=JSON.stringify({chainId:31337});
 await expect(createRuntime({STEWARD_MODE:'demo',STEWARD_PUBLIC_DEMO:'true',ORIGIN:'http://demo.example.test',DATABASE_PATH:':memory:'})).rejects.toThrow('HTTPS');
 await expect(createRuntime({STEWARD_MODE:'demo',STEWARD_PUBLIC_DEMO:'true',ORIGIN:origin,DATABASE_PATH:'data/demo.sqlite'})).rejects.toThrow('memory');
 const runtime=await createRuntime({STEWARD_MODE:'demo',STEWARD_PUBLIC_DEMO:'true',ORIGIN:origin,DATABASE_PATH:':memory:'});
 try{
  const request=(url:string,headers:Record<string,string>)=>runtime.app.request(`${url}/api/v1/auth/demo`,{method:'POST',headers:{'content-type':'application/json',...headers},body});
  expect((await request(origin,{})).status).toBe(404);
  expect((await request('https://other.example.test',{origin})).status).toBe(404);
  expect((await request(origin,{origin:'https://attacker.example.test'})).status).toBe(403);
  const login=await request(origin,{origin});expect(login.status).toBe(200);
  expect(login.headers.get('set-cookie')).toContain('Secure');
  const account=(await login.json()).data.account.id;
  const upload=await runtime.app.request(`${origin}/api/v1/accounts/${account}/attachments`,{method:'POST',headers:{origin,cookie:login.headers.get('set-cookie')!.split(';')[0]}});
  expect(upload.status).toBe(403);expect((await upload.json()).error.code).toBe('DEMO_UPLOADS_DISABLED');
  for(let attempt=1;attempt<30;attempt++)expect((await request(origin,{origin})).status).toBe(200);
  expect((await request(origin,{origin})).status).toBe(429);
 }finally{await runtime.close();}
});
test('configured email webhook rejects forgery and deduplicates authenticated delivery events',async()=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {randomBytes,createHmac}=await import('node:crypto');
 const directory=await mkdtemp(join(tmpdir(),'steward-mail-test-')),secret=randomBytes(32),timestamp=String(Math.floor(Date.now()/1000));
 let runtime:Awaited<ReturnType<typeof createRuntime>>|undefined;
 try{
 const manifest=join(directory,'manifest.json'),recipients=join(directory,'recipients.json');
 await writeFile(manifest,JSON.stringify({chainId:31337,version:'test',accounts:[],routes:[]}));await writeFile(recipients,'{}');
 runtime=await createRuntime({STEWARD_MODE:'live',ORIGIN:'https://steward.invalid',DATABASE_PATH:':memory:',STEWARD_SERVICE_KEY:randomBytes(32).toString('base64'),STEWARD_MANIFEST_PATH:manifest,STEWARD_RPC_URL:'http://127.0.0.1:1',STEWARD_EMAIL_API_KEY:'fixture-not-a-key',STEWARD_EMAIL_FROM:'fixture@example.invalid',STEWARD_EMAIL_RECIPIENTS_PATH:recipients,STEWARD_EMAIL_WEBHOOK_SECRET:secret.toString('base64')});
 const raw=JSON.stringify({type:'email.delivered',data:{email_id:'provider-1'}}),id='event-1';
 const base={'content-type':'application/json','svix-id':id,'svix-timestamp':timestamp};
 expect((await runtime.app.request('https://steward.invalid/api/v1/webhooks/email',{method:'POST',headers:{...base,'svix-signature':'v1,invalid'},body:raw})).status).toBe(400);
 const sig=createHmac('sha256',secret).update(`${id}.${timestamp}.${raw}`).digest('base64');
 for(let n=0;n<2;n++)expect((await runtime.app.request('https://steward.invalid/api/v1/webhooks/email',{method:'POST',headers:{...base,'svix-signature':`v1,${sig}`},body:raw})).status).toBe(200);
 expect(runtime.db.query('SELECT count(*) AS n FROM ops_email_webhooks').get()).toEqual({n:1});
 }finally{await runtime?.close();await rm(directory,{recursive:true,force:true});}
});

test('indexer outage does not prevent durable notifications',async()=>{
  const {Database}=await import('bun:sqlite'); const {startOperations}=await import('./runtime');const {initOperations,enqueue}=await import('./jobs');const {initIndexer,registerIndexAccount}=await import('./indexer');
  const db=new Database(':memory:');initOperations(db);initIndexer(db);registerIndexAccount(db,1,'0x1','family',1);enqueue(db,{accountId:'family',kind:'recovery.started',dedupeKey:'1',payload:{resourceId:'case1'}});
  const worker=startOperations({db,chainId:1,intervalMs:100000,source:{block:async()=>{throw Error('RPC down');},logs:async()=>[]}});
  await worker.stop();
  expect(db.query('SELECT status FROM ops_outbox').get()).toEqual({status:'delivered'});expect(worker.state.lastError).toBe('INDEXER_RETRY_PENDING');db.close();
});
