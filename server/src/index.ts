import {sqliteAssetRegistry} from './operations/asset-registry-store';
import {startMaintenanceWorker} from './operations/maintenance-worker';
import {drainQuarantinedAttachments,maintainEncryptedBackups,pruneOffsiteBackedLocalSnapshots,recordOffsiteBackupStatus} from './operations/maintenance';
import {createOffsiteBackupStore,offsiteConfigFromEnv} from './operations/offsite-backup';
import {startScannerDefinitions} from './operations/scanner-definitions';
import {clamAvScanner} from './operations/attachments';
import { Hono } from 'hono';
import { keccak256 } from 'viem';
import { AddressSchema } from '@steward/shared';
import { StewardPasskeySignerV1CreationCode } from './integrations/contracts.generated';
import { bodyLimit } from 'hono/body-limit';
import { serveStatic } from 'hono/bun';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createApp } from './app';
import { createDatabase } from './db';
import { DemoChainGateway } from './chain';
import { decodeServiceKey } from './crypto';
import { seedDemoDatabase } from './demo';
import { VerifiedLiveChainGateway,type LiveManifest } from './integrations/live-chain';
import { LiveManifestSchema } from './integrations/manifest';
import { seedEnrollmentTokens } from './integrations/enrollment-tokens';
import { createAdmissionEvaluator, type AssetCatalog } from './integrations/admission';
import { createHttpAdmissionSources } from './integrations/admission-http';
import { ReadRpcPool } from './integrations/rpc';
import { RobinhoodCatalog } from './integrations/robinhood';
import { BaseCryptoCatalog } from './integrations/base-crypto';
import { rpcIndexSource } from './integrations/chain-index';
import { startOperations, stagingIndexIntervalMs } from './operations/runtime';
import { createResendSender,verifyEmailWebhook } from './integrations/notifications';
import { initOperations,enqueue,inAppChannel,emailChannel,recordDelivered,recordDeliveryFailure } from './operations/jobs';
import { initIndexer,registerIndexAccount } from './operations/indexer';
import { compactDatabaseFreePages, safeCompactionAlertCode } from './operations/sqlite-compaction';
import { resourceSample } from './operations/resource-metrics';
import { rebuildTransactionProjections } from './operations/projections';

export async function createRuntime(env: Record<string,string|undefined> = process.env, dependencies: { admissionFetch?: typeof fetch; catalog?: AssetCatalog } = {}) {
  const mode=env.STEWARD_MODE??(env.DEMO_MODE==='true'?'demo':'live');
  if(mode!=='demo'&&mode!=='live')throw new Error('STEWARD_MODE must be demo or live');
  const demo=mode==='demo',publicDemo=demo&&env.STEWARD_PUBLIC_DEMO==='true',origin=env.ORIGIN??env.STEWARD_ORIGIN??'http://localhost:5173';
  const originUrl=new URL(origin);
  if(originUrl.origin!==origin)throw new Error('ORIGIN must be an exact origin without path or credentials');
  if(publicDemo){
    if(originUrl.protocol!=='https:'||['localhost','127.0.0.1','[::1]'].includes(originUrl.hostname))throw new Error('Public demo requires a non-loopback HTTPS origin');
    if((env.DATABASE_PATH??env.STEWARD_DB_PATH)!==':memory:')throw new Error('Public demo requires DATABASE_PATH=:memory:');
  }else if(demo&&!['localhost','127.0.0.1','[::1]'].includes(originUrl.hostname))throw new Error('Demo must use a loopback origin');
  if(!demo&&originUrl.protocol!=='https:'&&env.NODE_ENV==='production')throw new Error('Production requires HTTPS origin');
  const filename=env.DATABASE_PATH??env.STEWARD_DB_PATH??'data/steward.sqlite';
  if(filename!==':memory:')await mkdir(dirname(filename),{recursive:true,mode:0o700});
  let serviceKey:Uint8Array;
  if(demo&&!env.STEWARD_SERVICE_KEY&&filename!==':memory:'){
    const keyPath=`${filename}.demo-key`;
    try{serviceKey=decodeServiceKey(await readFile(keyPath,'utf8'),true);}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;serviceKey=randomBytes(32);await writeFile(keyPath,Buffer.from(serviceKey).toString('base64'),{flag:'wx',mode:0o600});}
  }else serviceKey=decodeServiceKey(env.STEWARD_SERVICE_KEY,demo);
  let maintenanceConfig:{directory:string;key:Uint8Array;keyVersion:string}|undefined;
  if(env.STEWARD_MAINTENANCE_ENABLED==='true'){
    if(demo)throw Error('MAINTENANCE_REQUIRES_LIVE_MODE');
    if(!env.STEWARD_BACKUP_DIRECTORY)throw Error('STEWARD_BACKUP_DIRECTORY_REQUIRED');
    const key=decodeServiceKey(env.STEWARD_BACKUP_KEY,false);
    if(Buffer.from(key).equals(Buffer.from(serviceKey)))throw Error('BACKUP_KEY_MUST_DIFFER_FROM_SERVICE_KEY');
    maintenanceConfig={directory:env.STEWARD_BACKUP_DIRECTORY,key,keyVersion:env.STEWARD_BACKUP_KEY_VERSION??'v1'};
  }
  const offsiteConfig=offsiteConfigFromEnv(env);
  if(offsiteConfig&&!maintenanceConfig)throw Error('OFFSITE_BACKUP_REQUIRES_MAINTENANCE');
  const localRetention=env.STEWARD_BACKUP_LOCAL_RETENTION===undefined?undefined:Number(env.STEWARD_BACKUP_LOCAL_RETENTION);
  if(localRetention!==undefined&&(!offsiteConfig||!Number.isInteger(localRetention)||localRetention<1||localRetention>999))throw Error('LOCAL_RETENTION_REQUIRES_OFFSITE');
  if(demo&&env.STEWARD_SCANNER_UPDATES_ENABLED==='true')throw Error('SCANNER_UPDATES_REQUIRE_LIVE_MODE');
  let manifest:LiveManifest|undefined,rpc:ReadRpcPool|undefined;
  if(!demo){
    if(!env.STEWARD_MANIFEST_PATH||!env.STEWARD_RPC_URL)throw new Error('Reviewed manifest and RPC configuration required');
    manifest=LiveManifestSchema.parse(JSON.parse(await readFile(env.STEWARD_MANIFEST_PATH,'utf8')));
    if(manifest.factoryV2){
      const rpcHost=new URL(env.STEWARD_RPC_URL).hostname;
      if(env.NODE_ENV==='production'||!['localhost','127.0.0.1','[::1]'].includes(rpcHost)||!['localhost','127.0.0.1','[::1]'].includes(originUrl.hostname))throw Error('V2_FACTORY_LOCAL_ONLY');
    }
    rpc=new ReadRpcPool([env.STEWARD_RPC_URL,...(env.STEWARD_RPC_FALLBACK_URL?[env.STEWARD_RPC_FALLBACK_URL]:[])],manifest.chainId);
  }
  const stagingOnly=env.STEWARD_STAGING_ONLY==='true';
  const indexIntervalMs=stagingIndexIntervalMs(env.STEWARD_STAGING_INDEX_INTERVAL_MS,stagingOnly);
  let stagingAllowedWallets:string[]|undefined;
  if(stagingOnly){
    if(demo||manifest?.chainId!==46630||manifest.routes.length!==0)throw Error('STAGING_REQUIRES_MOCK_ONLY_TESTNET');
    stagingAllowedWallets=(env.STEWARD_STAGING_ALLOWED_WALLETS??'').split(',').filter(Boolean).map(value=>AddressSchema.parse(value.trim()));
    if(stagingAllowedWallets.length===0||new Set(stagingAllowedWallets).size!==stagingAllowedWallets.length)throw Error('STAGING_WALLET_ALLOWLIST_INVALID');
  }
  const admissionConfig=[env.STEWARD_ADMISSION_ELIGIBILITY_URL,env.STEWARD_ADMISSION_MARKET_URL,env.STEWARD_ADMISSION_API_KEY];
  if(admissionConfig.some(Boolean)&&admissionConfig.some(value=>!value))throw Error('COMPLETE_ADMISSION_SOURCE_CONFIG_REQUIRED');
  if(demo&&admissionConfig.some(Boolean))throw Error('ADMISSION_SOURCES_REQUIRE_LIVE_MODE');
  const admissionSources=admissionConfig.every(Boolean)?createHttpAdmissionSources({eligibilityUrl:admissionConfig[0]!,marketUrl:admissionConfig[1]!,apiKey:admissionConfig[2]!,fetcher:dependencies.admissionFetch}):undefined;
  const db=createDatabase(filename);
  if(!demo)resourceSample('startup.beforeCompaction');
  if(!demo){
    try{
      const compacted=await compactDatabaseFreePages(db);
      if(compacted.compacted)console.log(JSON.stringify({event:'STEWARD_DB_COMPACTED',beforeBytes:compacted.beforeBytes,afterBytes:compacted.afterBytes}));
      else if(compacted.reason==='insufficient-space')console.error(JSON.stringify({event:'STEWARD_OPERATOR_ALERT',kind:'database_compaction',code:'DB_COMPACT_INSUFFICIENT_SPACE'}));
    }catch(error){
      console.error(JSON.stringify({event:'STEWARD_OPERATOR_ALERT',kind:'database_compaction',code:safeCompactionAlertCode(error)}));
      throw error;
    }
  }
  if(!demo)resourceSample('startup.afterCompaction');
  initOperations(db);initIndexer(db);
  if(!demo)await seedEnrollmentTokens(db,rpc!,manifest!);
  const catalog=!demo?(dependencies.catalog??(manifest!.chainId===8453?new BaseCryptoCatalog():manifest!.chainId===4663?new RobinhoodCatalog(4663):{assets:async()=>[]})):undefined;
  const admission=admissionSources?createAdmissionEvaluator({
    ...admissionSources,
    catalog:()=>catalog!.assets(),
  }):undefined;
  const chain=demo?new DemoChainGateway(31337):new VerifiedLiveChainGateway({rpc:rpc!,manifest:manifest!,catalog,assetRegistry:sqliteAssetRegistry(db,manifest!.chainId),...(admission?{marketGate:admission}:{})});
  if(demo)seedDemoDatabase(db,chain as DemoChainGateway);
  else for(const registered of manifest!.accounts){
    const row=db.query('SELECT id FROM accounts WHERE chain_id=? AND lower(address)=?').get(manifest!.chainId,registered.address.toLowerCase()) as {id:string}|null;
    if(row)registerIndexAccount(db,manifest!.chainId,registered.address,row.id,Number(registered.deploymentBlock));
  }
  const api=createApp({db,chain,config:{demoMode:demo,publicDemo,origin,serviceKey,secureCookies:!demo||publicDemo,...(publicDemo?{sessionTtlSeconds:3600}:{}),...(stagingOnly?{stagingAllowedWallets,stagingAllowedAccounts:manifest!.accounts.map(account=>account.address)}:{})}});
  const app=new Hono();
  app.use('*',async(c,next)=>{
    c.header('X-Content-Type-Options','nosniff');c.header('Referrer-Policy','no-referrer');c.header('X-Frame-Options','DENY');
    c.header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'");
    if(c.req.path.startsWith('/api/'))c.header('Cache-Control','no-store');await next();
  });
  let delivery: ReturnType<typeof inAppChannel>|undefined;
  if(!demo&&env.STEWARD_EMAIL_API_KEY){
    if(!env.STEWARD_EMAIL_FROM||!env.STEWARD_EMAIL_RECIPIENTS_PATH||!env.STEWARD_EMAIL_WEBHOOK_SECRET)throw new Error('Complete verified email configuration required');
    const recipients=JSON.parse(await readFile(env.STEWARD_EMAIL_RECIPIENTS_PATH,'utf8')) as Record<string,string>;
    const inApp=inAppChannel(db);
    const email=emailChannel(createResendSender({apiKey:env.STEWARD_EMAIL_API_KEY,from:env.STEWARD_EMAIL_FROM,recipientForAccount:async accountId=>recipients[accountId]??''}));
    delivery=async job=>{await inApp(job);return email(job);};
    db.exec('CREATE TABLE IF NOT EXISTS ops_email_failures(event_id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,received_at INTEGER NOT NULL)');
    db.exec('CREATE TABLE IF NOT EXISTS ops_email_webhooks(event_id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,delivered INTEGER NOT NULL,received_at INTEGER NOT NULL)');
    app.post('/api/v1/webhooks/email',bodyLimit({maxSize:65536}),async c=>{
      try{
        const event=verifyEmailWebhook({rawBody:await c.req.text(),id:c.req.header('svix-id')??'',timestamp:c.req.header('svix-timestamp')??'',signatures:c.req.header('svix-signature')??'',secret:env.STEWARD_EMAIL_WEBHOOK_SECRET!});
        db.query('INSERT OR IGNORE INTO ops_email_webhooks VALUES (?,?,?,?)').run(event.eventId,event.providerId,event.delivered?1:0,Date.now());
        if(event.failed)db.query('INSERT OR IGNORE INTO ops_email_failures VALUES (?,?,?)').run(event.eventId,event.providerId,Date.now());
        return c.json({received:true});
      }catch{return c.json({error:{code:'INVALID_WEBHOOK',message:'Invalid delivery proof'}},400);}
    });
  }
  app.get('/api/v1/passkeys/deployment-template',c=>demo?c.json({error:{code:'LIVE_REQUIRED',message:'Passkey deployment is unavailable in demo mode'}},409):c.json({data:{chainId:manifest!.chainId,bytecode:StewardPasskeySignerV1CreationCode,bytecodeHash:keccak256(StewardPasskeySignerV1CreationCode),rpId:originUrl.hostname,origin:originUrl.origin,enrolledEpoch:'1'}}));
  app.get('/api/v1/deployment-manifest',c=>c.json({data:manifest?{chainId:manifest.chainId,version:manifest.version,factory:manifest.factory??null,factoryV2:manifest.factoryV2??null,routes:manifest.routes}:null,meta:{mode:demo?'demo':'live',executionEnabled:false}}));
  const publicRobinhoodCatalog=new RobinhoodCatalog(4663);
  app.get('/api/v1/providers/robinhood/assets',async c=>{
    try{const assets=await publicRobinhoodCatalog.assets();return c.json({data:assets.map(({raw,...asset})=>asset),meta:{source:'robinhood-public-catalog',executionEnabled:false}});}
    catch{return c.json({error:{code:'ASSET_CATALOG_UNAVAILABLE',message:'Provider catalog is currently unavailable',retryable:true}},503);}
  });
  app.route('/',api);
  app.get('/api/*',c=>c.json({error:{code:'NOT_FOUND',message:'Route not found',retryable:false}},404));
  app.get('*',serveStatic({root:'./web/dist'}));
  app.get('*',serveStatic({path:'./web/dist/index.html'}));
  const bridgeAudit=()=>db.transaction(()=>{
    if(delivery){
      const delivered=db.query("SELECT DISTINCT w.provider_id FROM ops_email_webhooks w JOIN ops_outbox o ON o.provider_id=w.provider_id WHERE w.delivered=1 AND o.status='accepted'").all() as {provider_id:string}[];
      for(const event of delivered)recordDelivered(db,event.provider_id);
      const failed=db.query("SELECT DISTINCT w.provider_id FROM ops_email_failures w JOIN ops_outbox o ON o.provider_id=w.provider_id WHERE o.status IN ('accepted','delivered')").all() as {provider_id:string}[];
      for(const event of failed)recordDeliveryFailure(db,event.provider_id);
    }
    if(!demo){
      const registered=db.query('SELECT a.id,a.address,v.provenance_block FROM accounts a JOIN account_versions v ON v.account_id=a.id WHERE a.chain_id=?').all(manifest!.chainId) as {id:string;address:string;provenance_block:string}[];
      for(const row of registered)registerIndexAccount(db,manifest!.chainId,row.address,row.id,Number(row.provenance_block));
    }
    const cursor=Number((db.query("SELECT value FROM ops_meta WHERE key='audit_cursor'").get() as {value:string}|null)?.value??0);
    const rows=db.query('SELECT rowid AS sequence,account_id,event_type,target_id FROM audit_events WHERE rowid>? ORDER BY rowid LIMIT 100').all(cursor) as {sequence:number;account_id:string|null;event_type:string;target_id:string|null}[];
    for(const row of rows)if(row.account_id)enqueue(db,{accountId:row.account_id,kind:row.event_type,dedupeKey:`audit:${row.sequence}`,payload:{resourceId:row.target_id??String(row.sequence)}});
    if(rows.length)db.query("INSERT INTO ops_meta(key,value) VALUES ('audit_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(rows.at(-1)!.sequence));
  })();
  const operations=startOperations({db,delivery,chainId:demo?31337:manifest!.chainId,source:rpc?rpcIndexSource(rpc):undefined,rebuild:()=>rebuildTransactionProjections(db,demo?31337:manifest!.chainId),...(indexIntervalMs!==undefined?{indexIntervalMs}:{})});
  const offsite=offsiteConfig?createOffsiteBackupStore(offsiteConfig):undefined;
  const maintenance=maintenanceConfig?startMaintenanceWorker({
    onAlert:(kind,code)=>console.error(JSON.stringify({event:'STEWARD_OPERATOR_ALERT',kind,code})),
    scan:()=>drainQuarantinedAttachments(db,serviceKey,clamAvScanner(env.STEWARD_CLAMSCAN_PATH),{limit:4}),
    backup:async()=>{
      resourceSample('backup.before');
      try {
        const result=await maintainEncryptedBackups(db,maintenanceConfig!);
        console.log(JSON.stringify({event:'STEWARD_BACKUP_SIZE',createdBytes:result.createdBytes,verifiedBytes:result.verifiedBytes,verifiedCount:result.verified.length}));
        resourceSample('backup.verified');
        if(offsite&&result.verificationFailures.length===0){
          try{await offsite.upload(join(maintenanceConfig!.directory,result.created),maintenanceConfig!.key,maintenanceConfig!.keyVersion);recordOffsiteBackupStatus(db,true,result.created);}
          catch{recordOffsiteBackupStatus(db,false,result.created);throw Error('OFFSITE_UPLOAD_FAILED');}
          resourceSample('offsite.uploaded');
          if(localRetention!==undefined)await pruneOffsiteBackedLocalSnapshots(db,{...maintenanceConfig!,retain:localRetention});
        }
        return result;
      } finally { resourceSample('backup.end'); }
    }
  }):undefined;
  const scannerDefinitions=env.STEWARD_SCANNER_UPDATES_ENABLED==='true'?startScannerDefinitions({db}):undefined;
  const bridgeTimer=setInterval(bridgeAudit,5000);bridgeTimer.unref();bridgeAudit();
  return {app,db,chain,demo,operations,maintenance,scannerDefinitions,close:async()=>{clearInterval(bridgeTimer);await Promise.all([operations.stop(),maintenance?.stop(),scannerDefinitions?.stop()]);offsite?.destroy();db.close();}};
}
if(import.meta.main){
  const runtime=await createRuntime();
  const server=Bun.serve({fetch:runtime.app.fetch,hostname:runtime.demo&&process.env.STEWARD_PUBLIC_DEMO!=='true'?'127.0.0.1':'0.0.0.0',port:Number(process.env.PORT??3000)});
  console.log(`Steward ${runtime.demo?'local fake-funds demo':'configured live read/preparation service'} listening on port ${server.port}`);
  let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;server.stop(true);await runtime.close();process.exit(0);};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
