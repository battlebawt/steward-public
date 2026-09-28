import type { Database } from 'bun:sqlite';
import { initOperations, runOne, inAppChannel, type DeliveryChannel } from './jobs';
import { initIndexer, indexStep, type IndexSource } from './indexer';
export function stagingIndexIntervalMs(value: string|undefined, stagingOnly: boolean): number|undefined {
  if(!stagingOnly){if(value!==undefined)throw Error('STAGING_INDEX_INTERVAL_REQUIRES_STAGING');return undefined;}
  const interval=value===undefined?60_000:Number(value);
  if(!Number.isInteger(interval)||interval<30_000||interval>300_000)throw Error('INVALID_STAGING_INDEX_INTERVAL');
  return interval;
}
/** One service process, no replicas. Retries never create a signed spending transaction. */
export function startOperations(options: { db: Database; chainId: number; source?: IndexSource; delivery?: DeliveryChannel; rebuild?: () => void; intervalMs?: number; indexIntervalMs?: number; now?: () => number }) {
  initOperations(options.db); initIndexer(options.db);
  const now=options.now??Date.now;
  const indexIntervalMs=options.indexIntervalMs??options.intervalMs??5000;
  if(!Number.isInteger(indexIntervalMs)||indexIntervalMs<1000||indexIntervalMs>300_000)throw Error('INVALID_INDEX_INTERVAL');
  let deliveryBusy=false,indexBusy=false,stopped=false,indexFailures=0,nextIndexAt=0;
  let indexTimer:ReturnType<typeof setTimeout>|undefined;
  let deliveryError:string|null=null,indexError:string|null=null;
  const owner=crypto.randomUUID();
  const state: { lastSuccess: number|null; lastError: string|null; running: boolean }={lastSuccess:null,lastError:null,running:false};
  const refreshState=()=>{state.running=deliveryBusy||indexBusy;state.lastError=deliveryError??indexError;};
  const deliveryTick=async()=>{
    if(deliveryBusy||stopped)return;deliveryBusy=true;refreshState();
    try{
      for(let i=0;i<10;i++)if(!await runOne(options.db,owner,options.delivery??inAppChannel(options.db)))break;
      deliveryError=null;
      if(!options.source)state.lastSuccess=now();
    }catch {deliveryError='OPERATIONS_RETRY_PENDING';}
    finally {deliveryBusy=false;refreshState();}
  };
  const scheduleIndex=()=>{
    if(stopped||!options.source)return;
    indexTimer=setTimeout(()=>void indexTick(),Math.max(1,nextIndexAt-now()));indexTimer.unref();
  };
  const indexTick=async()=>{
    if(indexBusy||stopped||!options.source||now()<nextIndexAt)return;
    if(indexTimer)clearTimeout(indexTimer);
    indexBusy=true;refreshState();
    try{
      const result=await indexStep(options.db,options.chainId,options.source,options.rebuild);
      indexFailures=0;indexError=null;state.lastSuccess=now();
      // Catch up bounded chunks sooner, but use the full interval when no history is pending.
      nextIndexAt=now()+(result.state==='indexed'&&result.behind?Math.min(indexIntervalMs,15_000):indexIntervalMs);
    }catch{
      indexError='INDEXER_RETRY_PENDING';
      indexFailures++;
      nextIndexAt=now()+Math.min(300_000,indexIntervalMs*2**Math.min(indexFailures-1,10));
    }finally {indexBusy=false;refreshState();scheduleIndex();}
  };
  const timer=setInterval(()=>void deliveryTick(),options.intervalMs??5000);timer.unref();
  void deliveryTick();void indexTick();
  return { state, tick:async()=>Promise.all([deliveryTick(),indexTick()]), deliveryTick, indexTick, stop: async()=>{stopped=true;clearInterval(timer);if(indexTimer)clearTimeout(indexTimer);while(deliveryBusy||indexBusy)await new Promise(resolve=>setTimeout(resolve,20));} };
}
