import {test,expect} from 'bun:test';
import {keccak256,type Address} from 'viem';
import {VerifiedLiveChainGateway} from './live-chain';
import {ReadRpcPool} from './rpc';
import {type ActionIntent,ZERO_ADDRESS} from '@steward/shared';
import {EIP1967_IMPLEMENTATION_SLOT,ValuationSourceSchema} from './valuation';
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as Address;
const hash=`0x${'11'.repeat(32)}` as const;
function fixture(gate:boolean,assetRegistry?:{remember(account:Address,assets:readonly Address[]):void;list(account:Address):readonly Address[]}){
  let gateInput:unknown,quoted=false,called=false;const account=a(1),stock=a(2),adapter=a(3),settlement=a(4);
  const gateway=new VerifiedLiveChainGateway({rpc:new ReadRpcPool(['http://127.0.0.1:1'],31337),manifest:{chainId:31337,version:'test',accounts:[{address:account,runtimeCodeHash:keccak256('0x6000'),settlement,deploymentBlock:'1'}],routes:[{asset:stock,provider:'fixture',legalInstrumentType:'test_token',sourceTermsVersion:'fixture-1',adapter,adapterCodeHash:hash,quoter:a(5),fee:3000,session:'market'}]},assetRegistry,marketGate:async input=>{gateInput=input;return {allowed:gate,reason:'fixture',source:'fixture',observedAt:Date.now(),expiresAt:Date.now()+20_000};}});
  Object.assign(gateway.client,{getCode:async()=> '0x6000',getChainId:async()=>31337,call:async()=>{called=true;}});
  gateway.quote=async()=>{quoted=true;return {adapter,quoteId:'1',chainId:31337,assetIn:settlement,assetOut:stock,amountInRaw:'100',minAmountOutRaw:'95',feeRaw:'0',priceImpactBps:0,validUntil:'2099-01-01',routeHash:hash,status:'available'};};
  const action:ActionIntent={actionId:hash,kind:'BUY',account,actor:a(9),chainId:31337,securityEpoch:'1',policyVersion:'1',nonce:'1',tokenIn:settlement,tokenOut:stock,recipient:ZERO_ADDRESS,amountInRaw:'100',minAmountOutRaw:'1',adapter,routeHash:hash,validAfter:'1',deadline:'9999999999',exceptionMask:'0'};
  return {gateway,action,state:()=>({gateInput,quoted,called})};
}
test('manually constructed trades cannot bypass account and actor admission at prepare',async()=>{
  const f=fixture(false);expect((await f.gateway.simulateAction(f.action)).ok).toBe(false);
  expect(f.state().gateInput).toMatchObject({account:f.action.account,actor:f.action.actor,side:'BUY'});expect(f.state().quoted).toBe(false);expect(f.state().called).toBe(false);
});
test('signed minimum output cannot weaken the fresh independent trade floor',async()=>{
  const f=fixture(true);expect((await f.gateway.simulateAction(f.action)).ok).toBe(false);expect(f.state().quoted).toBe(true);expect(f.state().called).toBe(false);
});

test('holdings classify a reviewed route but admit only the actor and permitted side',async()=>{
 const f=fixture(true),account=f.action.account,actor=f.action.actor,stock=f.action.tokenOut,settlement=f.action.tokenIn,adapter=f.action.adapter;
 f.gateway.options.manifest.routes[0]!.provider='robinhood';
 f.gateway.options.catalog={assets:async()=>[{id:'fixture',provider:'robinhood',chainId:31337,address:stock,symbol:'STOCK',name:'Fixture stock',decimals:6,multiplier:'1',sessions:{market:'closing_only',extended:'unknown',overnight:'unknown'},active:true,eligibility:'review-required',termsUrl:'https://example.invalid',raw:{}}]};
 (f.gateway as any).readPolicyConfiguration=async()=>({settlement,approvedTokens:[stock],approvedAdapters:[adapter],version:7n});
 Object.assign(f.gateway.client,{getBlock:async()=>({number:42n,timestamp:100n}),readContract:async(input:any)=>input.functionName==='balanceOf'?1000000n:input.functionName==='symbol'?(input.address===stock?'STOCK':'USDG'):6});
 const holdings=await f.gateway.getAccountHoldings(account,actor);
 expect(holdings.find(item=>item.address===settlement)).toMatchObject({capabilities:['payment'],admission:'allowed'});
 expect(holdings.find(item=>item.address===stock)).toMatchObject({provider:'robinhood',legalInstrumentType:'test_token',capabilities:['sell'],admission:'allowed'});
 expect(f.state().gateInput).toMatchObject({account,actor,asset:stock,side:'SELL',policyVersion:'7'});
 f.gateway.options.marketGate=undefined;
 const unavailable=await f.gateway.getAccountHoldings(account,actor);
 expect(unavailable.find(item=>item.address===stock)).toMatchObject({capabilities:[],admission:'review_required'});
});

test('live quote rechecks actor, current policy, reviewed route and market source',async()=>{
 const f=fixture(true),account=f.action.account,actor=f.action.actor,stock=f.action.tokenOut,settlement=f.action.tokenIn,adapter=f.action.adapter;
 f.gateway.options.manifest.routes[0]!.provider='robinhood';
 f.gateway.options.manifest.routes[0]!.adapterCodeHash=keccak256('0x6000');
 f.gateway.options.catalog={assets:async()=>[{id:'fixture',provider:'robinhood',chainId:31337,address:stock,symbol:'STOCK',name:'Fixture stock',decimals:6,multiplier:'1',sessions:{market:'tradable',extended:'unknown',overnight:'unknown'},active:true,eligibility:'review-required',termsUrl:'https://example.invalid',raw:{}}]};
 f.gateway.quote=VerifiedLiveChainGateway.prototype.quote.bind(f.gateway);
 (f.gateway as any).readPolicyConfiguration=async()=>({settlement,approvedTokens:[stock],approvedAdapters:[adapter],version:7n});
 Object.assign(f.gateway.client,{getBlock:async()=>({number:42n}),readContract:async(input:any)=>input.functionName==='routeHash'?hash:input.functionName==='independentFloor'?95n:100n,simulateContract:async()=>({result:[100n,0n,0,0n]})});
 const quote=await f.gateway.quote({account,actor,kind:'BUY',asset:stock,amountInRaw:'100'});
 expect(quote.status).toBe('available');
 expect(f.state().gateInput).toMatchObject({account,actor,asset:stock,side:'BUY',policyVersion:'7'});
 f.gateway.options.marketGate=undefined;
 await expect(f.gateway.quote({account,actor,kind:'BUY',asset:stock,amountInRaw:'100'})).rejects.toThrow('ASSET_UNAVAILABLE');
});

test('prepared trade expires no later than the current admission decision',async()=>{
 const f=fixture(true),expiry=Date.now()+8_000;
 f.gateway.simulateAction=async()=>({ok:true});
 (f.gateway as any).signatures=async()=>[];
 f.gateway.options.marketGate=async()=>({allowed:true,reason:'fixture',source:'fixture',observedAt:Date.now(),expiresAt:expiry});
 const prepared=await f.gateway.prepareAction(f.action);
 expect(Date.parse(prepared.expiresAt)).toBeLessThanOrEqual(expiry);
 f.gateway.options.marketGate=async()=>({allowed:true,reason:'fixture',source:'fixture',observedAt:Date.now(),expiresAt:Date.now()-1});
 await expect(f.gateway.prepareAction(f.action)).rejects.toThrow('ASSET_UNAVAILABLE');
});

test('finalized continuity evidence accepts a sponsor wrapper but not another emitting account',async()=>{
 const {encodeEventTopics,parseAbi}=await import('viem');const f=fixture(false);const successor=a(8),target=f.action.account;
 const eventAbi=parseAbi(['event SuccessionExecuted(uint256 indexed id,address indexed successor)']);
 let emitter=target;
 Object.assign(f.gateway.client,{getTransactionReceipt:async()=>({status:'success',to:a(77),blockNumber:10n,blockHash:hash,logs:[{address:emitter,data:'0x',topics:encodeEventTopics({abi:eventAbi,eventName:'SuccessionExecuted',args:{id:7n,successor}})}]}),getBlock:async()=>({number:10n,hash})});
 const proof={caseId:'case1',account:target,type:'succession' as const,chainCaseId:'7',successor,transactionHash:hash};
 expect(await f.gateway.confirmContinuityExecution(proof)).toBe(true);emitter=a(99);expect(await f.gateway.confirmContinuityExecution(proof)).toBe(false);
});

test('policy reconstruction pins every read and filters revoked adapters',async()=>{
  const f=fixture(false),calls:any[]=[];
  const lists=[[a(2)],[a(5)],[a(6)],[a(7)],[a(8),a(9)],[a(2)]];
  Object.assign(f.gateway.client,{getBlock:async()=>({number:42n,timestamp:100n}),readContract:async(input:any)=>{
    calls.push(input);expect(input.blockNumber).toBe(42n);
    switch(input.functionName){
      case 'policy':return [a(4),86400n,0n,1000n,2000n,50n,100n,200n,300n,1n,3n];
      case 'policyAddresses':return lists[input.args[0]];
      case 'continuityReviewer':return a(10);
      case 'continuitySuccessor':return a(11);
      case 'continuityPlanHash':return hash;
      case 'approvedAdapter':return input.args[0]===a(9);
      case 'sellLimit':return 700n;
      case 'parent':return a(12);
      case 'securityEpoch':return 2n;
      default:throw Error('Unexpected read '+input.functionName);
    }
  }});
  const config=await (f.gateway as any).readPolicyConfiguration(f.action.account,42n);
  expect(config.approvedAdapters).toEqual([a(9)]);expect(config.sellCaps).toEqual([700n]);
  expect(config.continuitySuccessor).toBe(a(11));expect(config.continuityPlanHash).toBe(hash);
  const result=await f.gateway.getAccountPolicy(f.action.account);
  expect(result).toMatchObject({parent:a(12),securityEpoch:'2',policyVersion:'3',policy:{allowedAssets:[a(4),a(2)],allowedRecipients:[a(5)],paymentMaxRaw:'100',exceptionQuorum:1}});
  expect(new Set(calls.map(c=>c.blockNumber))).toEqual(new Set([42n]));
});

test('valuation uses block-pinned per-token prices, accounts for depeg and never totals missing prices',async()=>{
 const {valueInUsd}=await import('./valuation');
 expect(valueInUsd(123456789012345678901n,18,123456789n,8)).toBe(15241578751n);
 const observed=new Set<Address>();let includePolicyAsset=true;
 const registry={remember:(_account:Address,assets:readonly Address[])=>assets.forEach(asset=>observed.add(asset)),list:(_account:Address)=>[...observed]};
 const f=fixture(false,registry);let missing=false,stale=false,paused=false,badCode=false;
 const immutable=(asset:Address)=>({asset,source:a(20),sourceCodeHash:keccak256('0x6000'),maxAgeSeconds:60,quoteCurrency:'USD' as const,priceBasis:'per-token' as const,sourceKind:'immutable' as const});
 f.gateway.options.manifest.valuationSources=[a(4),a(2)].map(immutable);
 Object.assign(f.gateway.client,{getBlock:async()=>({number:42n,hash:hash,timestamp:100n}),getCode:async(input:any)=>{
  if(input.address===a(20)){expect(input.blockNumber).toBe(42n);return badCode?'0x6001':'0x6000';}return '0x6000';
 },readContract:async(input:any)=>{
  expect(input.blockNumber).toBe(42n);
  switch(input.functionName){
   case 'policy':return [a(4),86400n,0n,1000n,2000n,50n,100n,200n,300n,1n,3n];case 'policyAddresses':return input.args[0]===0&&includePolicyAsset?[a(2)]:[];
   case 'continuityReviewer':return a(10);case 'continuitySuccessor':return a(11);case 'continuityPlanHash':return hash;
   case 'approvedAdapter':return false;case 'sellLimit':return 0n;
   case 'balanceOf':return input.address===a(4)?10_000_000n:2_000_000_000_000_000_000n;
   case 'decimals':return input.address===a(4)?6:18;
   case 'price':if(missing&&input.args[0]===a(2))throw Error('feed down');return [input.args[0]===a(4)?95_000_000n:20_000_000_000n,8,stale?1n:99n,paused];
   default:throw Error('unexpected read');
  }
 }});
 const value=await f.gateway.getPortfolioValuation(f.action.account);expect(value.totalValueRaw).toBe('40950000000');expect(value.status).toBe('complete');expect(value.scope).toBe('policy-and-observed-assets');expect(value.observedBlockHash).toBe(hash);expect(value.finality).toBe('latest');
 const priced=value.holdings.find(holding=>holding.address===a(2));expect(priced).toMatchObject({source:a(20),sourceCodeHash:keccak256('0x6000'),sourceKind:'immutable',priceBasis:'per-token',maxAgeSeconds:60,priceRaw:'20000000000',priceDecimals:8,observedBlock:'42',observedBlockHash:hash,finality:'latest'});
 includePolicyAsset=false;f.gateway.options.manifest.valuationSources=[immutable(a(4))];const retained=await f.gateway.getPortfolioValuation(f.action.account);expect(retained.holdings.some(holding=>holding.address===a(2)&&holding.status==='unavailable')).toBe(true);expect(retained.holdings.find(holding=>holding.address===a(2))?.reason).toBe('REVIEWED_PRICE_SOURCE_MISSING');
 f.gateway.options.manifest.valuationSources=[a(4),a(2)].map(immutable);missing=true;const partial=await f.gateway.getPortfolioValuation(f.action.account);expect(partial.totalValueRaw).toBeNull();expect(partial.pricedSubtotalRaw).toBe('950000000');expect(partial.status).toBe('partial');
 missing=false;stale=true;expect((await f.gateway.getPortfolioValuation(f.action.account)).status).toBe('unavailable');
 stale=false;paused=true;expect((await f.gateway.getPortfolioValuation(f.action.account)).totalValueRaw).toBeNull();
 paused=false;badCode=true;expect((await f.gateway.getPortfolioValuation(f.action.account)).totalValueRaw).toBeNull();
});

test('valuation rejects an eip1967 source when the implementation pin differs at the observed block',async()=>{
 const f=fixture(false);f.gateway.options.manifest.valuationSources=[immutableSource(a(4)),{...immutableSource(a(2)),sourceKind:'eip1967',implementation:a(21),implementationCodeHash:keccak256('0x6000')}];
 Object.assign(f.gateway.client,{getBlock:async()=>({number:42n,hash:hash,timestamp:100n}),getCode:async()=> '0x6000',getStorageAt:async(input:any)=>{expect(input.slot).toBe(EIP1967_IMPLEMENTATION_SLOT);return `0x${'00'.repeat(12)}${a(22).slice(2)}`;},readContract:async(input:any)=>{
  expect(input.blockNumber).toBe(42n);switch(input.functionName){case 'policy':return [a(4),86400n,0n,1000n,2000n,50n,100n,200n,300n,1n,3n];case 'policyAddresses':return input.args[0]===0?[a(2)]:[];case 'continuityReviewer':return a(10);case 'continuitySuccessor':return a(11);case 'continuityPlanHash':return hash;case 'approvedAdapter':return false;case 'sellLimit':return 0n;case 'balanceOf':return input.address===a(4)?10_000_000n:2_000_000_000_000_000_000n;case 'decimals':return input.address===a(4)?6:18;case 'price':return [95_000_000n,8,99n,false];default:throw Error('unexpected read');}
 }});
 const result=await f.gateway.getPortfolioValuation(f.action.account);expect(result.status).toBe('partial');expect(result.holdings.find(holding=>holding.address===a(2))).toMatchObject({status:'unavailable',reason:'PRICE_SOURCE_IMPLEMENTATION_MISMATCH'});
});

function immutableSource(asset:Address){return {asset,source:a(20),sourceCodeHash:keccak256('0x6000'),maxAgeSeconds:60,quoteCurrency:'USD' as const,priceBasis:'per-token' as const,sourceKind:'immutable' as const};}

test('valuation source schema requires paired implementation pins for eip1967 sources',()=>{
 expect(()=>ValuationSourceSchema.parse(immutableSource(a(2)))).not.toThrow();
 expect(()=>ValuationSourceSchema.parse({...immutableSource(a(2)),sourceKind:'eip1967'})).toThrow();
});
