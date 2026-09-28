import {test,expect} from 'bun:test';
import {createAdmissionEvaluator,type EligibilityDecision,type MarketObservation,type AdmissionRequest} from './admission';
import type {CatalogAsset} from './robinhood';
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as const;
test('admission binds account actor asset chain side, expiry, current market session and capability',async()=>{
 const input:AdmissionRequest={account:a(1),actor:a(2),asset:a(3),chainId:4663,policyVersion:'review-1',side:'BUY',session:'market'};
 const base:EligibilityDecision={...input,status:'allowed',policyVersion:'review-1',source:'fixture-reviewer',evidence:'fixture-evidence',observedAt:90000,expiresAt:110000};
 let eligibility=base;
 const marketBase:MarketObservation={chainId:4663,asset:a(3),session:'market',state:'open',halted:false,source:'fixture-market',observedAt:99000,expiresAt:114000};let market=marketBase;
 let asset={address:a(3),chainId:4663,active:true,sessions:{market:'tradable',extended:'unknown',overnight:'unknown'}} as CatalogAsset;
 const evaluate=createAdmissionEvaluator({eligibility:async()=>eligibility,market:async()=>market,catalog:async()=>[asset],now:()=>100000});
 expect((await evaluate(input)).allowed).toBe(true);
 for(const patch of [{actor:a(8)},{account:a(8)},{asset:a(8)},{chainId:1},{side:'SELL'},{policyVersion:'older'},{expiresAt:100000},{observedAt:100001},{status:'review-required'},{evidence:''}]){eligibility={...base,...patch} as EligibilityDecision;expect((await evaluate(input)).allowed).toBe(false);}
 eligibility=base;for(const patch of [{halted:true},{state:'unknown'},{session:'overnight'},{observedAt:60000},{expiresAt:200000},{asset:a(8)}]){market={...marketBase,...patch} as MarketObservation;expect((await evaluate(input)).allowed).toBe(false);}
 market=marketBase;asset={...asset,sessions:{...asset.sessions,market:'closing_only'}};expect((await evaluate(input)).allowed).toBe(false);
 // Account-wide quote clearance must not become actor-specific execution clearance.
 eligibility={...base,actor:a(8)};expect((await evaluate(input)).reason).toBe('ELIGIBILITY_UNAVAILABLE');
});
test('an unavailable eligibility dependency denies, with a redacted reason',async()=>{
 const evaluate=createAdmissionEvaluator({eligibility:async()=>{throw Error('private credential');},market:async()=>{throw Error('private account');},catalog:async()=>[]});
 const result=await evaluate({account:a(1),actor:a(3),asset:a(2),side:'SELL',chainId:1,policyVersion:'1',session:'market'});expect(result.allowed).toBe(false);expect(JSON.stringify(result)).not.toContain('private');
});
