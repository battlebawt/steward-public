import type {Address} from 'viem';
import {sessionAllows,type CatalogAsset} from './robinhood';
export type AssetCatalog={assets:()=>Promise<CatalogAsset[]>};
export type AdmissionRequest={account:Address;actor:Address;asset:Address;side:'BUY'|'SELL';chainId:number;policyVersion:string;session:'market'|'extended'|'overnight'};
export type AdmissionDecision={allowed:boolean;reason:string;source:string;observedAt:number;expiresAt:number};
export type EligibilityDecision={status:'allowed'|'blocked'|'review-required'|'unknown';account:Address;actor:Address;asset:Address;chainId:number;side:'BUY'|'SELL';policyVersion:string;source:string;evidence:string;observedAt:number;expiresAt:number};
export type MarketObservation={chainId:number;asset:Address;session:AdmissionRequest['session'];state:'open'|'closed'|'unknown';halted:boolean;source:string;observedAt:number;expiresAt:number};
const same=(a:string|undefined,b:string|undefined)=>a?.toLowerCase()===b?.toLowerCase();
/** Policy dependencies are supplied by the reviewed pilot operating model. No default eligibility. */
export function createAdmissionEvaluator(deps:{eligibility:(input:AdmissionRequest)=>Promise<EligibilityDecision>;market:(input:AdmissionRequest)=>Promise<MarketObservation>;catalog:()=>Promise<CatalogAsset[]>;now?:()=>number}){
 return async(input:AdmissionRequest):Promise<AdmissionDecision>=>{
  const now=deps.now??Date.now;const denied=(reason:string):AdmissionDecision=>({allowed:false,reason,source:'steward-admission',observedAt:now(),expiresAt:now()});
  try{
   const [eligibility,market,assets]=await Promise.all([deps.eligibility(input),deps.market(input),deps.catalog()]);
   const time=now();
   const fresh=(d:{observedAt:number;expiresAt:number})=>Number.isSafeInteger(d.observedAt)&&Number.isSafeInteger(d.expiresAt)&&d.observedAt<=time&&d.expiresAt>time&&d.observedAt>0;
   if(eligibility.status!=='allowed'||!fresh(eligibility)||time-eligibility.observedAt>300_000||eligibility.expiresAt-eligibility.observedAt>300_000||!input.actor||!input.policyVersion||!eligibility.source||!eligibility.evidence||eligibility.policyVersion!==input.policyVersion||eligibility.chainId!==input.chainId||!same(eligibility.account,input.account)||!same(eligibility.actor,input.actor)||!same(eligibility.asset,input.asset)||eligibility.side!==input.side)return denied('ELIGIBILITY_UNAVAILABLE');
   // Tradability capability alone is not proof that the selected session is open.
   if(!fresh(market)||time-market.observedAt>30_000||market.expiresAt-market.observedAt>30_000||market.state!=='open'||market.halted!==false||!market.source||market.chainId!==input.chainId||!same(market.asset,input.asset)||market.session!==input.session)return denied('MARKET_UNAVAILABLE');
   const matches=assets.filter(a=>a.chainId===input.chainId&&same(a.address,input.asset));
   if(matches.length!==1||!matches[0]!.active||!sessionAllows(matches[0]!.sessions[input.session],input.side))return denied('CAPABILITY_UNAVAILABLE');
   return {allowed:true,reason:'REVIEWED_DEPENDENCIES_ALLOW',source:`${eligibility.source}; ${market.source}`,observedAt:time,expiresAt:Math.min(eligibility.expiresAt,market.expiresAt)};
  }catch{return denied('ADMISSION_DEPENDENCY_UNAVAILABLE');}
 };
}
