import { createPublicClient, custom, encodeAbiParameters, encodeFunctionData, decodeFunctionData, decodeEventLog, keccak256, hashTypedData, parseAbi, type Address, type Hex } from 'viem';
import { ACTION_TYPES, actionDomain, actionMessage, hashActionIntent, expectedV2ShellRuntimeCodeHash, CowOrderSchema, contractCowOrder, cowOrderDigest, V2_COW_ORDER_ABI, type CowOrderInput, type ActionIntent, type PreparedTransaction } from '@steward/shared';
import type { ChainGateway, ChainReceipt, ChainQuote, ContinuityExecutionProof, ContinuityRequestProof, DeploymentReceiptProof, VerifiedDeployment, V2OrderContext, V2OrderStatus, V2OrderResolution } from '../chain';
import { StewardAccountV1Abi as accountAbi, StewardTradeAdapterV1Abi as adapterAbi, StewardFactoryV1Abi as factoryAbi, StewardIncapacityModuleV1Abi as incapacityAbi } from './contracts.generated';
import {valueInUsd,ValuationSourceSchema,EIP1967_IMPLEMENTATION_SLOT,type ValuationSource,type PortfolioValuation} from './valuation';
import type {ObservedAssetRegistry} from './asset-registry';
import { buildAccessKit,verifyAccessKit } from './access-kit';
import { continuityCall } from './continuity';
import { ReadRpcPool } from './rpc';
import { contractPolicy,managementCall } from './management';
import { sessionAllows } from './robinhood';
import type { AdmissionDecision, AdmissionRequest, AssetCatalog } from './admission';
const erc20Abi=parseAbi(['function balanceOf(address) view returns(uint256)','function symbol() view returns(string)','function decimals() view returns(uint8)']);
const cowSettlementAbi=parseAbi(['function filledAmount(bytes) view returns(uint256)']);
const quoterAbi=parseAbi(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns(uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)']);
export type CollectedApproval={signer:Address;signature:Hex;signatureType?:'eoa'|'erc1271'|'passkey'};
const v2FactoryAbi=parseAbi(['function v1Implementation() view returns(address)','function cowModule() view returns(address)','function accountRuntimeCodeHash() view returns(bytes32)','function accountCount() view returns(uint256)']);
const v2ModuleAbi=parseAbi(['function settlement() view returns(address)','function stockToken() view returns(address)','function priceGuard() view returns(address)','function relayer() view returns(address)','function maxFeeBps() view returns(uint256)','function deploymentChainId() view returns(uint256)','function budgetStatus(address,uint256) view returns(uint256 reservedToken,uint256 reservedPeriod,uint256 spentPeriod)']);
const v2ShellAbi=parseAbi(['function v1Implementation() view returns(address)','function cowModule() view returns(address)']);
export type LiveAccountManifest={address:Address;runtimeCodeHash:Hex;settlement:Address;deploymentBlock:string;implementation?:Address;implementationCodeHash?:Hex;accountVersion?:'v2'};
export type LiveFactoryV2={address:Address;runtimeCodeHash:Hex;accountRuntimeCodeHash:Hex;v1Implementation:Address;v1ImplementationCodeHash:Hex;cowModule:Address;cowModuleCodeHash:Hex;settlement:Address;settlementCodeHash:Hex;stockToken:Address;stockTokenCodeHash:Hex;priceGuard:Address;priceGuardCodeHash:Hex;relayer:Address;relayerCodeHash:Hex;maxFeeBps:string};
export type LiveRoute={asset:Address;provider:string;legalInstrumentType:string;sourceTermsVersion:string;adapter:Address;adapterCodeHash:Hex;quoter:Address;fee:number;session:'market'|'extended'|'overnight'};
export type ContinuityProof={type:'recovery'|'succession';chainCaseId:string;successor:Address;transactionHash:Hex};
export type LiveManifest={chainId:number;version:string;accounts:LiveAccountManifest[];routes:LiveRoute[];enrollmentTokens?:Array<{address:Address;runtimeCodeHash:Hex;symbol:string;name:string;decimals:number;provider:string;sourceTermsVersion:string}>;valuationSources?:ValuationSource[];incapacityModules?:Array<{account:Address;address:Address;runtimeCodeHash:Hex}>;factory?:{address:Address;runtimeCodeHash:Hex;implementation:Address;implementationCodeHash:Hex};factoryV2?:LiveFactoryV2};
export class VerifiedLiveChainGateway implements ChainGateway {
  readonly mode='live' as const;
  readonly client;
  constructor(readonly options:{rpc:ReadRpcPool;manifest:LiveManifest;catalog?:AssetCatalog;assetRegistry?:ObservedAssetRegistry; marketGate?:(input:AdmissionRequest)=>Promise<AdmissionDecision>; continuityProof?:(caseId:string,account:Address)=>Promise<ContinuityProof|undefined>}) {
    if(options.manifest.chainId!==options.rpc.chainId)throw new Error('WRONG_CHAIN');
    this.client=createPublicClient({transport:custom({request:async({method,params})=>options.rpc.request(method,params as unknown[]??[])})});
  }
  async getChainId(){const chain=await this.client.getChainId();if(chain!==this.options.manifest.chainId)throw Error('WRONG_CHAIN');return chain;}
  private async registered(address:Address){
    let manifest=this.options.manifest.accounts.find(a=>a.address.toLowerCase()===address.toLowerCase());
    if(!manifest){
      const v2=this.options.manifest.factoryV2?await this.verifiedFactoryV2():undefined;
      if(v2&&await this.client.readContract({address:v2.address,abi:factoryAbi,functionName:'isStewardAccount',args:[address]})){
        const policy=await this.client.readContract({address,abi:accountAbi,functionName:'policy'});
        manifest={address,runtimeCodeHash:v2.accountRuntimeCodeHash,settlement:policy[0],deploymentBlock:'0',implementation:v2.v1Implementation,implementationCodeHash:v2.v1ImplementationCodeHash,accountVersion:'v2'};
      } else {
        const factory=await this.verifiedFactory();
        if(!await this.client.readContract({address:factory.address,abi:factoryAbi,functionName:'isStewardAccount',args:[address]}))throw new Error('ACCOUNT_MANIFEST_UNAVAILABLE');
        const policy=await this.client.readContract({address,abi:accountAbi,functionName:'policy'});
        const cloneCode=`0x363d3d373d3d3d363d73${factory.implementation.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3` as Hex;
        manifest={address,runtimeCodeHash:keccak256(cloneCode),settlement:policy[0],deploymentBlock:'0',implementation:factory.implementation,implementationCodeHash:factory.implementationCodeHash};
      }
    }
    const code=await this.client.getCode({address});
    if(!code||keccak256(code)!==manifest.runtimeCodeHash)throw new Error('ACCOUNT_CODE_MISMATCH');
    if(manifest.accountVersion==='v2'){
      const v2=await this.verifiedFactoryV2();
      if(manifest.runtimeCodeHash!==v2.accountRuntimeCodeHash||manifest.implementation?.toLowerCase()!==v2.v1Implementation.toLowerCase()||manifest.implementationCodeHash!==v2.v1ImplementationCodeHash)throw new Error('ACCOUNT_COMPONENT_MISMATCH');
      const [v1,module,member]=await Promise.all([this.client.readContract({address,abi:v2ShellAbi,functionName:'v1Implementation'}),this.client.readContract({address,abi:v2ShellAbi,functionName:'cowModule'}),this.client.readContract({address:v2.address,abi:factoryAbi,functionName:'isStewardAccount',args:[address]})]);
      if(!member||v1.toLowerCase()!==v2.v1Implementation.toLowerCase()||module.toLowerCase()!==v2.cowModule.toLowerCase())throw new Error('ACCOUNT_COMPONENT_MISMATCH');
    }
    const clone=/^0x363d3d373d3d3d363d73([a-fA-F0-9]{40})5af43d82803e903d91602b57fd5bf3$/.exec(code);
    if(clone){
      if(!manifest.implementation||!manifest.implementationCodeHash||manifest.implementation.toLowerCase()!==`0x${clone[1]}`.toLowerCase())throw new Error('IMPLEMENTATION_MANIFEST_UNAVAILABLE');
      const implementation=await this.client.getCode({address:manifest.implementation});
      if(!implementation||keccak256(implementation)!==manifest.implementationCodeHash)throw new Error('IMPLEMENTATION_CODE_MISMATCH');
    }
    return manifest;
  }
  async getDelegateAuthority(account:Address,delegate:Address){
    await this.registered(account);const block=await this.client.getBlock();
    const [grant,epoch]=await Promise.all([this.client.readContract({address:account,abi:accountAbi,functionName:'delegates',args:[delegate],blockNumber:block.number}),this.client.readContract({address:account,abi:accountAbi,functionName:'securityEpoch',blockNumber:block.number})]);
    return {active:grant[4]&&grant[3]===epoch&&grant[2]>block.timestamp,actionMask:grant[0].toString(),expiresAt:grant[2].toString(),securityEpoch:epoch.toString()};
  }
  async verifyWalletSignature(input:{address:Address;message:string;signature:Hex}){try{return await this.client.verifyMessage(input);}catch{return false;}}
  async verifyActionSignature(input:{action:ActionIntent;signature:Hex;signer:Address}){
    const code=await this.client.getCode({address:input.signer});const signatureType=code&&code!=='0x'?'erc1271' as const:'eoa' as const;
    try{return {valid:await this.client.verifyTypedData({address:input.signer,domain:actionDomain(input.action),types:ACTION_TYPES,primaryType:'Action',message:actionMessage(input.action),signature:input.signature}),signatureType};}catch{return {valid:false,signatureType};}
  }
  private async verifiedFactory(){
    const factory=this.options.manifest.factory;if(!factory)throw new Error('FACTORY_MANIFEST_UNAVAILABLE');
    const [code,implementationCode,target]=await Promise.all([this.client.getCode({address:factory.address}),this.client.getCode({address:factory.implementation}),this.client.readContract({address:factory.address,abi:factoryAbi,functionName:'implementation'})]);
    if(!code||keccak256(code)!==factory.runtimeCodeHash||!implementationCode||keccak256(implementationCode)!==factory.implementationCodeHash||target.toLowerCase()!==factory.implementation.toLowerCase())throw new Error('FACTORY_CODE_MISMATCH');
    return factory;
  }
  private async verifiedFactoryV2(){
    const factory=this.options.manifest.factoryV2;if(!factory)throw new Error('FACTORY_V2_MANIFEST_UNAVAILABLE');
    const pins=[['address','runtimeCodeHash'],['v1Implementation','v1ImplementationCodeHash'],['cowModule','cowModuleCodeHash'],['settlement','settlementCodeHash'],['stockToken','stockTokenCodeHash'],['priceGuard','priceGuardCodeHash'],['relayer','relayerCodeHash']] as const;
    const codes=await Promise.all(pins.map(async([addressKey,hashKey])=>{const code=await this.client.getCode({address:factory[addressKey]});return !!code&&keccak256(code)===factory[hashKey]}));
    if(codes.some(ok=>!ok))throw new Error('FACTORY_V2_CODE_MISMATCH');
    const [v1,module,runtime,count,settlement,stock,guard,relayer,fee,chain]=await Promise.all([
      this.client.readContract({address:factory.address,abi:v2FactoryAbi,functionName:'v1Implementation'}),this.client.readContract({address:factory.address,abi:v2FactoryAbi,functionName:'cowModule'}),this.client.readContract({address:factory.address,abi:v2FactoryAbi,functionName:'accountRuntimeCodeHash'}),this.client.readContract({address:factory.address,abi:v2FactoryAbi,functionName:'accountCount'}),
      this.client.readContract({address:factory.cowModule,abi:v2ModuleAbi,functionName:'settlement'}),this.client.readContract({address:factory.cowModule,abi:v2ModuleAbi,functionName:'stockToken'}),this.client.readContract({address:factory.cowModule,abi:v2ModuleAbi,functionName:'priceGuard'}),this.client.readContract({address:factory.cowModule,abi:v2ModuleAbi,functionName:'relayer'}),this.client.readContract({address:factory.cowModule,abi:v2ModuleAbi,functionName:'maxFeeBps'}),this.client.readContract({address:factory.cowModule,abi:v2ModuleAbi,functionName:'deploymentChainId'})]);
    const emptyHash=`0x${'00'.repeat(32)}`;
    if(v1.toLowerCase()!==factory.v1Implementation.toLowerCase()||module.toLowerCase()!==factory.cowModule.toLowerCase()||expectedV2ShellRuntimeCodeHash(v1,module)!==factory.accountRuntimeCodeHash||(runtime!==factory.accountRuntimeCodeHash&&(runtime!==emptyHash||count!==0n))||settlement.toLowerCase()!==factory.settlement.toLowerCase()||stock.toLowerCase()!==factory.stockToken.toLowerCase()||guard.toLowerCase()!==factory.priceGuard.toLowerCase()||relayer.toLowerCase()!==factory.relayer.toLowerCase()||fee!==BigInt(factory.maxFeeBps)||chain!==BigInt(this.options.manifest.chainId))throw new Error('FACTORY_V2_COMPONENT_MISMATCH');
    return factory;
  }
  async prepareDeployment(parent:Address,policy:unknown,accountVersion:'v1'|'v2'='v1'):Promise<PreparedTransaction>{
    const factory=accountVersion==='v2'?await this.verifiedFactoryV2():await this.verifiedFactory();
    const data=encodeFunctionData({abi:factoryAbi,functionName:'createAccount',args:[parent,contractPolicy(policy)]});
    await this.client.call({account:parent,to:factory.address,data});
    return {chainId:this.options.manifest.chainId,to:factory.address,value:'0',data,actionHash:keccak256(data),manifestVersion:this.options.manifest.version,simulation:{ok:true},expiresAt:new Date(Date.now()+30000).toISOString()};
  }
  async confirmDeployment(proof:DeploymentReceiptProof):Promise<VerifiedDeployment>{
    const receipt=await this.client.getTransactionReceipt({hash:proof.transactionHash});
    const accountVersion=receipt.to?.toLowerCase()===this.options.manifest.factoryV2?.address.toLowerCase()?'v2':'v1';
    const factory=accountVersion==='v2'?await this.verifiedFactoryV2():await this.verifiedFactory();
    if(receipt.status!=='success'||receipt.to?.toLowerCase()!==factory.address.toLowerCase())throw new Error('DEPLOYMENT_PROOF_MISMATCH');
    const [block,finalized,tx]=await Promise.all([this.client.getBlock({blockNumber:receipt.blockNumber}),this.client.getBlock({blockTag:'finalized'}),this.client.getTransaction({hash:proof.transactionHash})]);
    if(block.hash!==receipt.blockHash||finalized.number<receipt.blockNumber)throw new Error('DEPLOYMENT_NOT_FINALIZED');
    const decoded=decodeFunctionData({abi:factoryAbi,data:tx.input});
    if(decoded.functionName!=='createAccount'||decoded.args[0].toLowerCase()!==proof.parent.toLowerCase()||tx.value!==0n)throw new Error('DEPLOYMENT_PROOF_MISMATCH');
    const config=decoded.args[1];
    let account:Address|undefined;
    const expectedManifest=await this.client.readContract({address:factory.address,abi:factoryAbi,functionName:'MANIFEST'});
    for(const log of receipt.logs){
      if(log.address.toLowerCase()!==factory.address.toLowerCase())continue;
      try{const event=decodeEventLog({abi:factoryAbi,data:log.data,topics:log.topics});if(event.eventName==='AccountCreated'&&event.args.parent.toLowerCase()===proof.parent.toLowerCase()&&event.args.manifest===expectedManifest)account=event.args.account;}catch{}
    }
    if(!account)throw new Error('DEPLOYMENT_EVENT_MISSING');
    const manifest=await this.registered(account),authority=await this.getAccountAuthority(account);
    if(accountVersion==='v2'&&manifest.accountVersion!=='v2')throw new Error('DEPLOYMENT_COMPONENT_MISMATCH');
    if(authority.parent.toLowerCase()!==proof.parent.toLowerCase())throw new Error('PARENT_CHANGED');
    // The API can reconcile an already registered account after its policy changes.
    // First registration still requires the creation policy and is checked before persistence.
    if(authority.policyVersion==='1'&&authority.securityEpoch==='1'&&!this.options.manifest.accounts.some(a=>a.address.toLowerCase()===account!.toLowerCase()))this.options.manifest.accounts.push({...manifest,deploymentBlock:receipt.blockNumber.toString()});
    const implementation='v1Implementation' in factory?factory.v1Implementation:factory.implementation;
    return {chainId:this.options.manifest.chainId,account,parent:proof.parent,implementation,accountVersion,factory:factory.address,cowModule:'cowModule' in factory?factory.cowModule:undefined,manifestVersion:this.options.manifest.version,deploymentBlock:receipt.blockNumber.toString(),deploymentBlockHash:receipt.blockHash,policyVersion:authority.policyVersion,securityEpoch:authority.securityEpoch,policy:{version:'1',allowedActions:['PAYMENT','BUY','SELL'],allowedRecipients:config.paymentRecipients.map(a=>a.toLowerCase()),allowedAssets:[config.settlement,...config.approvedTokens].map(a=>a.toLowerCase()),paymentMaxRaw:config.perPayment.toString(),buyMaxRaw:config.perBuy.toString(),sellMaxRaw:config.perSell.toString(),settlementReserveRaw:config.reserve.toString(),requiredApprovals:0,exceptionApprovers:config.exceptionSigners.map(a=>a.toLowerCase()),exceptionQuorum:Number(config.exceptionQuorum),continuityQuorum:config.guardians.map(a=>a.toLowerCase()),reviewer:config.continuityReviewer.toLowerCase()}};
  }
  private async registeredIncapacity(account:Address){
    const module=this.options.manifest.incapacityModules?.find(m=>m.account.toLowerCase()===account.toLowerCase());
    if(!module)throw new Error('INCAPACITY_MANIFEST_UNAVAILABLE');
    const [code,target,enrolled]=await Promise.all([this.client.getCode({address:module.address}),this.client.readContract({address:module.address,abi:incapacityAbi,functionName:'account'}),this.client.readContract({address:account,abi:accountAbi,functionName:'incapacityModule'})]);
    if(!code||keccak256(code)!==module.runtimeCodeHash||target.toLowerCase()!==account.toLowerCase()||enrolled.toLowerCase()!==module.address.toLowerCase())throw new Error('INCAPACITY_MANIFEST_MISMATCH');
    return module;
  }
  async prepareContinuity(account:Address,requester:Address,input:unknown):Promise<PreparedTransaction>{
    await this.registered(account);
    const call=continuityCall(input);
    const to=call.target==='account'?account:(await this.registeredIncapacity(account)).address;
    const data=encodeFunctionData({abi:call.target==='account'?accountAbi:incapacityAbi,functionName:call.method,args:call.args} as any);
    // Contract authorization and timing are authoritative, including reviewer/guardian roles.
    await this.client.call({account:requester,to,data});
    return {chainId:this.options.manifest.chainId,to,value:'0',data,actionHash:keccak256(data),manifestVersion:this.options.manifest.version,simulation:{ok:true},expiresAt:new Date(Date.now()+30000).toISOString()};
  }
  async preparePolicyChange(account:Address,requester:Address,input:unknown):Promise<PreparedTransaction>{
    const authority=await this.getAccountAuthority(account);if(authority.parent.toLowerCase()!==requester.toLowerCase())throw new Error('NOT_AUTHORIZED');
    const call=managementCall(input);
    const data=encodeFunctionData({abi:accountAbi,functionName:call.method,args:call.args} as any);
    await this.client.call({account:requester,to:account,data});
    return {chainId:this.options.manifest.chainId,to:account,value:'0',data,actionHash:keccak256(data),manifestVersion:this.options.manifest.version,simulation:{ok:true},expiresAt:new Date(Date.now()+30000).toISOString()};
  }
  async getIndependentAccessKit(account:Address){
    const entry=await this.registered(account);
    const kit=buildAccessKit({...this.options.manifest,accounts:[entry]},account);
    return verifyAccessKit(kit,this.options.rpc);
  }
  async getAccountSnapshot(account:Address){
    const manifest=await this.registered(account),block=await this.client.getBlock();
    const balance=await this.client.readContract({address:manifest.settlement,abi:erc20Abi,functionName:'balanceOf',args:[account],blockNumber:block.number});
    return {blockNumber:block.number.toString(),settlementBalanceRaw:balance.toString(),totalValueRaw:balance.toString()};
  }
  // Reconstruct the configuration at one block; never mix policy versions across reads.
  private async readPolicyConfiguration(account:Address,blockNumber:bigint){
    const at={address:account,blockNumber,abi:accountAbi};
    const [policy,lists,continuityReviewer,continuitySuccessor,continuityPlanHash]=await Promise.all([
      this.client.readContract({...at,functionName:'policy'}),
      Promise.all([0,1,2,3,4,5].map(list=>this.client.readContract({...at,functionName:'policyAddresses',args:[list]}))),
      this.client.readContract({...at,functionName:'continuityReviewer'}),
      this.client.readContract({...at,functionName:'continuitySuccessor'}),
      this.client.readContract({...at,functionName:'continuityPlanHash'})]);
    const [approvedTokens,paymentRecipients,exceptionSigners,guardians,adapters,sellCapTokens]=lists;
    const [active,sellCaps]=await Promise.all([
      Promise.all(adapters.map(adapter=>this.client.readContract({...at,functionName:'approvedAdapter',args:[adapter]}))),
      Promise.all(sellCapTokens.map(token=>this.client.readContract({...at,functionName:'sellLimit',args:[token]})))]);
    const result={settlement:policy[0],period:policy[1],anchor:policy[2],paymentLimit:policy[3],buyLimit:policy[4],reserve:policy[5],perPayment:policy[6],perBuy:policy[7],perSell:policy[8],exceptionQuorum:policy[9],version:policy[10],approvedTokens,paymentRecipients,exceptionSigners,guardians,approvedAdapters:adapters.filter((_,i)=>active[i]),sellCapTokens,sellCaps,continuityReviewer,continuitySuccessor,continuityPlanHash};
    await this.options.assetRegistry?.remember(account,[result.settlement,...result.approvedTokens].map(token=>token.toLowerCase() as Address));
    return result;
  }
  async getAccountHoldings(account:Address,actor:Address){
    await this.registered(account);
    const block=await this.client.getBlock();
    const config=await this.readPolicyConfiguration(account,block.number);
    const observed=await this.options.assetRegistry?.list(account)??[];
    const tokens=[...new Set([config.settlement,...config.approvedTokens,...observed].map(a=>a.toLowerCase() as Address))];
    const catalogAssets=this.options.manifest.routes.length?await this.options.catalog?.assets().catch(()=>[])??[]:[];
    return Promise.all(tokens.map(async token=>{
      const [balance,symbol,decimals]=await Promise.all([
        this.client.readContract({address:token,abi:erc20Abi,functionName:'balanceOf',args:[account],blockNumber:block.number}),
        this.client.readContract({address:token,abi:erc20Abi,functionName:'symbol',blockNumber:block.number}),
        this.client.readContract({address:token,abi:erc20Abi,functionName:'decimals',blockNumber:block.number})]);
      const settlement=token===config.settlement.toLowerCase();
      const route=this.options.manifest.routes.find(r=>r.asset.toLowerCase()===token);
      const catalogAsset=route?catalogAssets.find(a=>a.address.toLowerCase()===token&&a.chainId===this.options.manifest.chainId&&a.provider===route.provider):undefined;
      const reviewed=!!route&&!!catalogAsset?.active&&catalogAsset.decimals===decimals&&catalogAsset.symbol.toLowerCase()===symbol.toLowerCase()&&config.approvedTokens.some(a=>a.toLowerCase()===token)&&config.approvedAdapters.some(a=>a.toLowerCase()===route.adapter.toLowerCase());
      const capabilities:Array<'buy'|'sell'|'payment'>=settlement?['payment']:[];
      if(!settlement&&reviewed&&route&&this.options.marketGate){
        const sides=['BUY','SELL'] as const;
        const admitted=await Promise.all(sides.map(async side=>{
          if(!catalogAsset||!sessionAllows(catalogAsset.sessions[route.session],side))return false;
          try{const decision=await this.options.marketGate!({account,actor,asset:token,side,chainId:this.options.manifest.chainId,policyVersion:config.version.toString(),session:route.session});return decision.allowed&&decision.expiresAt>Date.now();}catch{return false;}
        }));
        sides.forEach((side,index)=>{if(admitted[index])capabilities.push(side.toLowerCase() as 'buy'|'sell');});
      }
      const admitted=capabilities.includes('buy')||capabilities.includes('sell');
      return {id:`${this.options.manifest.chainId}:${token}`,provider:settlement?'settlement':route?.provider??'unclassified',chainId:this.options.manifest.chainId,address:token,symbol,name:symbol,decimals,legalInstrumentType:settlement?'settlement_token':route?.legalInstrumentType??'unclassified_token',sourceTermsVersion:settlement?'onchain-policy':route?.sourceTermsVersion??'review-required',capabilities,admission:settlement||admitted?'allowed' as const:'review_required' as const,admissionReason:settlement||admitted?undefined:'Reviewed token metadata, account policy, actor eligibility or current market observation is unavailable',balanceRaw:balance.toString(),observedBlock:block.number.toString(),observedAt:new Date(Number(block.timestamp)*1000).toISOString()};
    }));
  }
  async getPortfolioValuation(account:Address):Promise<PortfolioValuation>{
    await this.registered(account);const block=await this.client.getBlock();
    const config=await this.readPolicyConfiguration(account,block.number);
    const observed=await this.options.assetRegistry?.list(account)??[];
    const reviewed=(this.options.manifest.valuationSources??[]).map(source=>source.asset);
    const addresses=[...new Set([config.settlement,...config.approvedTokens,...observed,...reviewed].map(a=>a.toLowerCase() as Address))];
    if(!block.hash)throw Error('VALUATION_BLOCK_HASH_UNAVAILABLE');
    const blockHash=block.hash;
    const priceAbi=parseAbi(['function price(address) view returns(uint256 value,uint8 decimals,uint256 updatedAt,bool paused)']);
    const holdings=await Promise.all(addresses.map(async address=>{
      const [balance,decimals]=await Promise.all([
        this.client.readContract({address,abi:erc20Abi,functionName:'balanceOf',args:[account],blockNumber:block.number}),
        this.client.readContract({address,abi:erc20Abi,functionName:'decimals',blockNumber:block.number})]);
      const configured=this.options.manifest.valuationSources?.find(s=>s.asset.toLowerCase()===address);
      let source:ValuationSource|undefined;
      try{source=configured?ValuationSourceSchema.parse(configured):undefined;}catch{return {address,balanceRaw:balance.toString(),decimals,observedBlock:block.number.toString(),observedBlockHash:blockHash,finality:'latest' as const,source:null,sourceCodeHash:null,sourceKind:null,implementation:null,implementationCodeHash:null,implementationSlot:null,priceBasis:null,maxAgeSeconds:null,priceRaw:null,priceDecimals:null,valueRaw:null,priceUpdatedAt:null,status:'unavailable' as const,reason:'PRICE_SOURCE_CONFIG_INVALID'};}
      const base={address,balanceRaw:balance.toString(),decimals,observedBlock:block.number.toString(),observedBlockHash:blockHash,finality:'latest' as const,source:(source?.source??null) as Address|null,sourceCodeHash:(source?.sourceCodeHash??null) as Hex|null,sourceKind:source?.sourceKind??null,implementation:(source?.implementation??null) as Address|null,implementationCodeHash:(source?.implementationCodeHash??null) as Hex|null,implementationSlot:(source?.sourceKind==='eip1967'?(source.implementationSlot??EIP1967_IMPLEMENTATION_SLOT):null) as Hex|null,priceBasis:source?.priceBasis??null,maxAgeSeconds:source?.maxAgeSeconds??null,priceRaw:null as string|null,priceDecimals:null as number|null};
      if(balance===0n)return {...base,valueRaw:'0',priceUpdatedAt:null,status:'priced' as const};
      if(!source)return {...base,valueRaw:null,priceUpdatedAt:null,status:'unavailable' as const,reason:'REVIEWED_PRICE_SOURCE_MISSING'};
      try{
        if(source.quoteCurrency!=='USD'||source.priceBasis!=='per-token')throw Error('PRICE_BASIS_MISMATCH');
        const code=await this.client.getCode({address:source.source,blockNumber:block.number});
        if(!code||keccak256(code).toLowerCase()!==source.sourceCodeHash.toLowerCase())throw Error('PRICE_SOURCE_MISMATCH');
        if(source.sourceKind==='eip1967'){
          if(!source.implementation||!source.implementationCodeHash)throw Error('PRICE_SOURCE_IMPLEMENTATION_PINS_MISSING');
          const slot=(source.implementationSlot??EIP1967_IMPLEMENTATION_SLOT) as Hex;
          const storage=await this.client.getStorageAt({address:source.source,slot,blockNumber:block.number});
          const implementation=`0x${(storage??'0x').slice(-40)}`.toLowerCase();
          if(implementation!==source.implementation.toLowerCase())throw Error('PRICE_SOURCE_IMPLEMENTATION_MISMATCH');
          const implementationCode=await this.client.getCode({address:source.implementation,blockNumber:block.number});
          if(!implementationCode||keccak256(implementationCode).toLowerCase()!==source.implementationCodeHash.toLowerCase())throw Error('PRICE_SOURCE_IMPLEMENTATION_CODE_MISMATCH');
        }
        const [value,priceDecimals,updatedAt,paused]=await this.client.readContract({address:source.source,abi:priceAbi,functionName:'price',args:[address],blockNumber:block.number});
        if(paused||value===0n||updatedAt===0n||updatedAt>block.timestamp||block.timestamp-updatedAt>BigInt(source.maxAgeSeconds))throw Error('PRICE_UNAVAILABLE');
        return {...base,priceRaw:value.toString(),priceDecimals, valueRaw:valueInUsd(balance,decimals,value,priceDecimals).toString(),priceUpdatedAt:updatedAt.toString(),status:'priced' as const};
      }catch(error){
        const reason=error instanceof Error&&error.message.startsWith('PRICE_SOURCE_')?error.message:'PRICE_UNAVAILABLE';
        return {...base,valueRaw:null,priceUpdatedAt:null,status:'unavailable' as const,reason};
      }
    }));
    if((await this.client.getBlock({blockNumber:block.number})).hash!==block.hash)throw Error('VALUATION_REORG');
    // Unknown prices stay null. A partial subtotal must never masquerade as total NAV.
    const complete=holdings.every(h=>h.status==='priced'),priced=holdings.filter(h=>h.status==='priced');
    const subtotal=priced.reduce((sum,h)=>sum+BigInt(h.valueRaw!),0n).toString();
    return {scope:'policy-and-observed-assets',currency:'USD',decimals:8,observedBlock:block.number.toString(),observedBlockHash:blockHash,finality:'latest',observedAt:new Date(Number(block.timestamp)*1000).toISOString(),status:complete?'complete':priced.some(h=>BigInt(h.balanceRaw)>0n)?'partial':'unavailable',totalValueRaw:complete?subtotal:null,pricedSubtotalRaw:subtotal,holdings};
  }
  async getBudget(account:Address){
    const manifest=await this.registered(account),block=await this.client.getBlock();
    const [policy,start,unit]=await Promise.all([
      this.client.readContract({address:account,abi:accountAbi,functionName:'policy',blockNumber:block.number}),
      this.client.readContract({address:account,abi:accountAbi,functionName:'periodStart',blockNumber:block.number}),
      this.client.readContract({address:manifest.settlement,abi:erc20Abi,functionName:'symbol',blockNumber:block.number})]);
    const spent=await this.client.readContract({address:account,abi:accountAbi,functionName:'paymentSpent',args:[manifest.settlement,start],blockNumber:block.number});
    const limit=policy[3];
    let buyBudget: {limitRaw:string;chargedRaw:string;pendingRaw:string;availableRaw:string}|undefined;
    if(manifest.accountVersion==='v2'){
      const [v1Spent,status]=await Promise.all([this.client.readContract({address:account,abi:accountAbi,functionName:'buySpent',args:[start],blockNumber:block.number}),this.client.readContract({address:account,abi:v2ModuleAbi,functionName:'budgetStatus',args:[manifest.settlement,start],blockNumber:block.number})]);
      // CoW spentPeriod includes proven fills and conservative charges for
      // expired orders whose outcome is unresolved; it is not a fill count.
      const charged=v1Spent+status[2],pending=status[1],buyLimit=policy[4];
      buyBudget={limitRaw:buyLimit.toString(),chargedRaw:charged.toString(),pendingRaw:pending.toString(),availableRaw:charged+pending>=buyLimit?'0':(buyLimit-charged-pending).toString()};
    }
    return {limitRaw:limit.toString(),spentRaw:spent.toString(),remainingRaw:(spent>=limit?0n:limit-spent).toString(),unit,period:policy[1]===86400n?'daily' as const:'fixed' as const,resetAt:new Date(Number(start+policy[1])*1000).toISOString(),pendingRequests:0,buyBudget};
  }
  async getV2OrderContext(account:Address):Promise<V2OrderContext|null>{
    const entry=await this.registered(account);if(entry.accountVersion!=='v2')return null;
    const f=await this.verifiedFactoryV2(),block=await this.client.getBlock();
    const [policy,start,epoch,parent,exceptionSigners,settlementSymbol,stockSymbol,settlementDecimals,stockDecimals]=await Promise.all([
      this.client.readContract({address:account,abi:accountAbi,functionName:'policy',blockNumber:block.number}),
      this.client.readContract({address:account,abi:accountAbi,functionName:'periodStart',blockNumber:block.number}),
      this.client.readContract({address:account,abi:accountAbi,functionName:'securityEpoch',blockNumber:block.number}),
      this.client.readContract({address:account,abi:accountAbi,functionName:'parent',blockNumber:block.number}),
      this.client.readContract({address:account,abi:accountAbi,functionName:'policyAddresses',args:[2],blockNumber:block.number}),
      this.client.readContract({address:entry.settlement,abi:erc20Abi,functionName:'symbol',blockNumber:block.number}),
      this.client.readContract({address:f.stockToken,abi:erc20Abi,functionName:'symbol',blockNumber:block.number}),
      this.client.readContract({address:entry.settlement,abi:erc20Abi,functionName:'decimals',blockNumber:block.number}),
      this.client.readContract({address:f.stockToken,abi:erc20Abi,functionName:'decimals',blockNumber:block.number})]);
    return {chainId:this.options.manifest.chainId,account,parent,settlementToken:entry.settlement,stockToken:f.stockToken,cowSettlement:f.settlement,settlementSymbol,stockSymbol,settlementDecimals:Number(settlementDecimals),stockDecimals:Number(stockDecimals),policyVersion:policy[10].toString(),securityEpoch:epoch.toString(),periodEnd:(start+policy[1]).toString(),maxFeeBps:f.maxFeeBps,exceptionSigners,exceptionQuorum:Number(policy[9]),manifestVersion:this.options.manifest.version};
  }
  async prepareV2Order(input:{account:Address;actor:Address;order:CowOrderInput;action:ActionIntent;approvals:Array<{signer:Address;signature:Hex}>}):Promise<PreparedTransaction>{
    const ctx=await this.getV2OrderContext(input.account);if(!ctx)throw Error('V2_ACCOUNT_REQUIRED');
    const o=CowOrderSchema.parse(input.order),a=input.action,digest=cowOrderDigest(o,ctx.chainId,ctx.cowSettlement);
    const same=(left:string,right:string)=>left.toLowerCase()===right.toLowerCase();
    const isBuy=same(o.sellToken,ctx.settlementToken)&&same(o.buyToken,ctx.stockToken);
    if(!isBuy&&!(same(o.sellToken,ctx.stockToken)&&same(o.buyToken,ctx.settlementToken)))throw Error('ORDER_TOKEN_PAIR_MISMATCH');
    const gross=BigInt(o.sellAmount)+BigInt(o.feeAmount),block=await this.client.getBlock();
    if(BigInt(o.sellAmount)===0n||BigInt(o.buyAmount)===0n||gross>(1n<<256n)-1n||BigInt(o.feeAmount)*10000n>BigInt(o.sellAmount)*BigInt(ctx.maxFeeBps)||BigInt(o.validTo)<=block.timestamp||BigInt(o.validTo)>=BigInt(ctx.periodEnd))throw Error('ORDER_BOUNDS_INVALID');
    if(!same(o.receiver,input.account)||!same(a.account,input.account)||!same(a.actor,input.actor)||a.chainId!==ctx.chainId||a.kind!==(isBuy?'BUY':'SELL')||a.actionId!==digest||a.routeHash!==digest||!same(a.tokenIn,o.sellToken)||!same(a.tokenOut,o.buyToken)||!same(a.recipient,input.account)||a.amountInRaw!==gross.toString()||a.minAmountOutRaw!==o.buyAmount||!same(a.adapter,ctx.cowSettlement)||a.deadline!==o.validTo||BigInt(a.validAfter)>block.timestamp||a.policyVersion!==ctx.policyVersion||a.securityEpoch!==ctx.securityEpoch)throw Error('ORDER_ACTION_MISMATCH');
    const onchainDigest=await this.client.readContract({address:input.account,abi:V2_COW_ORDER_ABI,functionName:'orderDigest',args:[contractCowOrder(o)]});
    if(onchainDigest!==digest)throw Error('ORDER_DIGEST_MISMATCH');
    if(input.approvals.length<1||input.approvals.length>5||!input.approvals.some(p=>p.signer.toLowerCase()===input.actor.toLowerCase()))throw Error('ORDER_ACTOR_SIGNATURE_REQUIRED');
    const seen=new Set<string>();for(const approval of input.approvals){const signer=approval.signer.toLowerCase();if(seen.has(signer)||!/^0x[0-9a-fA-F]{130}$/.test(approval.signature))throw Error('ORDER_SIGNATURE_INVALID');seen.add(signer);if(!(await this.verifyActionSignature({action:a,signer:approval.signer,signature:approval.signature})).valid)throw Error('ORDER_SIGNATURE_INVALID');}
    const data=encodeFunctionData({abi:V2_COW_ORDER_ABI,functionName:'openOrder',args:[contractCowOrder(o),actionMessage(a),input.approvals.map(p=>p.signature)]});
    await this.client.call({account:input.actor,to:input.account,data});
    return {chainId:ctx.chainId,to:input.account,value:'0',data,actionHash:hashActionIntent(a),manifestVersion:ctx.manifestVersion,simulation:{ok:true},expiresAt:new Date(Math.min(Date.now()+30000,Number(o.validTo)*1000)).toISOString()};
  }
  async getV2OrderStatus(account:Address,digest:Hex):Promise<V2OrderStatus>{
    const ctx=await this.getV2OrderContext(account);if(!ctx)throw Error('V2_ACCOUNT_REQUIRED');
    const block=await this.client.getBlock();
    const record=await this.client.readContract({address:account,abi:V2_COW_ORDER_ABI,functionName:'pendingOrder',args:[digest],blockNumber:block.number});
    if(record.state===0)return {digest,state:'unknown',venue:'local_fixture_only'};
    const uid=await this.client.readContract({address:account,abi:V2_COW_ORDER_ABI,functionName:'orderUid',args:[digest,record.validTo],blockNumber:block.number});
    const filled=await this.client.readContract({address:ctx.cowSettlement,abi:cowSettlementAbi,functionName:'filledAmount',args:[uid],blockNumber:block.number});
    const state=record.state===2?'filled':record.state===3?'cancelled':record.state===4?'expired_unresolved':filled===record.sellAmount?'fill_observed':BigInt(record.validTo)<block.timestamp?'expired_unresolved':'pending';
    let sellBudget:V2OrderStatus['sellBudget'];
    if(!record.isBuy){
      const [v1Spent,limit,cow]=await Promise.all([this.client.readContract({address:account,abi:accountAbi,functionName:'sellSpent',args:[ctx.stockToken,record.periodStart],blockNumber:block.number}),this.client.readContract({address:account,abi:accountAbi,functionName:'sellLimit',args:[ctx.stockToken],blockNumber:block.number}),this.client.readContract({address:account,abi:V2_COW_ORDER_ABI,functionName:'budgetStatus',args:[ctx.stockToken,record.periodStart],blockNumber:block.number})]);
      const charged=v1Spent+cow[2],pending=cow[1];sellBudget={limitRaw:limit.toString(),chargedRaw:charged.toString(),pendingRaw:pending.toString(),availableRaw:charged+pending>=limit?'0':(limit-charged-pending).toString(),token:ctx.stockToken};
    }
    return {digest,state,actor:record.actor,side:record.isBuy?'buy':'sell',grossSellRaw:record.grossSell.toString(),validTo:record.validTo.toString(),fillEvidenceRaw:filled.toString(),venue:'local_fixture_only',sellBudget};
  }
  async prepareV2Close(account:Address,actor:Address,digest:Hex,operation:'cancel'|'reconcile'):Promise<PreparedTransaction>{
    const ctx=await this.getV2OrderContext(account);if(!ctx)throw Error('V2_ACCOUNT_REQUIRED');
    const record=await this.client.readContract({address:account,abi:V2_COW_ORDER_ABI,functionName:'pendingOrder',args:[digest]});
    if(record.state!==1)throw Error('ORDER_NOT_PENDING');
    if(operation==='cancel'&&actor.toLowerCase()!==ctx.parent.toLowerCase()&&actor.toLowerCase()!==record.actor.toLowerCase())throw Error('ORDER_CANCEL_UNAUTHORIZED');
    const data=encodeFunctionData({abi:V2_COW_ORDER_ABI,functionName:operation==='cancel'?'cancelOrder':'reconcile',args:[digest]});
    await this.client.call({account:actor,to:account,data});
    return {chainId:ctx.chainId,to:account,value:'0',data,actionHash:digest,manifestVersion:ctx.manifestVersion,simulation:{ok:true},expiresAt:new Date(Date.now()+30000).toISOString()};
  }
  async confirmV2OrderTransaction(account:Address,digest:Hex,hash:Hex,operation:'open'|'cancel'|'reconcile',expectedData?:Hex):Promise<V2OrderResolution>{
    const ctx=await this.getV2OrderContext(account);if(!ctx)throw Error('V2_ACCOUNT_REQUIRED');
    const receipt=await this.client.getTransactionReceipt({hash});
    if(receipt.to?.toLowerCase()!==account.toLowerCase())throw Error('ORDER_RECEIPT_MISMATCH');
    const [included,finalized,tx]=await Promise.all([this.client.getBlock({blockNumber:receipt.blockNumber}),this.client.getBlock({blockTag:'finalized'}),this.client.getTransaction({hash})]);
    if(included.hash!==receipt.blockHash||finalized.number<receipt.blockNumber||tx.to?.toLowerCase()!==account.toLowerCase()||tx.value!==0n)throw Error('ORDER_NOT_FINALIZED');
    if(expectedData&&tx.input.toLowerCase()!==expectedData.toLowerCase())throw Error('ORDER_RECEIPT_MISMATCH');
    const decoded=decodeFunctionData({abi:V2_COW_ORDER_ABI,data:tx.input});
    if(operation==='open'){
      if(decoded.functionName!=='openOrder')throw Error('ORDER_RECEIPT_MISMATCH');
      const order=CowOrderSchema.parse({...decoded.args[0],sellAmount:decoded.args[0].sellAmount.toString(),buyAmount:decoded.args[0].buyAmount.toString(),validTo:decoded.args[0].validTo.toString(),feeAmount:decoded.args[0].feeAmount.toString()});
      if(cowOrderDigest(order,ctx.chainId,ctx.cowSettlement)!==digest||decoded.args[1].actionId!==digest)throw Error('ORDER_RECEIPT_MISMATCH');
    } else if(decoded.functionName!==(operation==='cancel'?'cancelOrder':'reconcile')||decoded.args[0]!==digest)throw Error('ORDER_RECEIPT_MISMATCH');
    if(receipt.status==='reverted')return {outcome:'reverted',status:await this.getV2OrderStatus(account,digest)};
    if(receipt.status!=='success')throw Error('ORDER_RECEIPT_MISMATCH');
    let eventSeen=false;for(const log of receipt.logs){if(log.address.toLowerCase()!==account.toLowerCase())continue;try{const event=decodeEventLog({abi:V2_COW_ORDER_ABI,data:log.data,topics:log.topics});if(event.args.digest===digest&&event.eventName===(operation==='open'?'OrderOpened':'OrderClosed'))eventSeen=true;}catch{}}
    if(!eventSeen)throw Error('ORDER_EVENT_MISSING');
    return {outcome:'confirmed',status:await this.getV2OrderStatus(account,digest)};
  }
  async getAccountAuthority(account:Address){
    await this.registered(account);
    const block=await this.client.getBlock();
    const [parent,epoch,version]=await Promise.all([
      this.client.readContract({address:account,abi:accountAbi,functionName:'parent',blockNumber:block.number}),
      this.client.readContract({address:account,abi:accountAbi,functionName:'securityEpoch',blockNumber:block.number}),
      this.client.readContract({address:account,abi:accountAbi,functionName:'policy',blockNumber:block.number})]);
    return {parent,securityEpoch:epoch.toString(),policyVersion:version[10].toString()};
  }
  async getAccountPolicy(account:Address){
    await this.registered(account);
    const block=await this.client.getBlock();
    const [parent,epoch,policy,config]=await Promise.all([
      this.client.readContract({address:account,abi:accountAbi,functionName:'parent',blockNumber:block.number}),
      this.client.readContract({address:account,abi:accountAbi,functionName:'securityEpoch',blockNumber:block.number}),
      this.client.readContract({address:account,abi:accountAbi,functionName:'policy',blockNumber:block.number}),
      this.readPolicyConfiguration(account,block.number)]);
    return {parent,securityEpoch:epoch.toString(),policyVersion:policy[10].toString(),policy:{version:policy[10].toString(),allowedActions:['PAYMENT','BUY','SELL'],allowedRecipients:config.paymentRecipients.map(a=>a.toLowerCase()),allowedAssets:[config.settlement,...config.approvedTokens].map(a=>a.toLowerCase()),paymentMaxRaw:config.perPayment.toString(),buyMaxRaw:config.perBuy.toString(),sellMaxRaw:config.perSell.toString(),settlementReserveRaw:config.reserve.toString(),requiredApprovals:0,exceptionApprovers:config.exceptionSigners.map(a=>a.toLowerCase()),exceptionQuorum:Number(config.exceptionQuorum),continuityQuorum:config.guardians.map(a=>a.toLowerCase()),reviewer:config.continuityReviewer.toLowerCase()}};
  }
  async quote(input:{account:Address;actor:Address;kind:'BUY'|'SELL';asset:Address;amountInRaw:string}):Promise<ChainQuote>{
    const manifest=await this.registered(input.account);
    const route=this.options.manifest.routes.find(r=>r.asset.toLowerCase()===input.asset.toLowerCase());
    if(!route||!this.options.catalog||!this.options.marketGate)throw new Error('ASSET_UNAVAILABLE');
    const block=await this.client.getBlock();
    const policy=await this.readPolicyConfiguration(input.account,block.number);
    if(!policy.approvedTokens.some(a=>a.toLowerCase()===input.asset.toLowerCase())||!policy.approvedAdapters.some(a=>a.toLowerCase()===route.adapter.toLowerCase()))throw new Error('ASSET_UNAVAILABLE');
    const admission=await this.options.marketGate({account:input.account,actor:input.actor,asset:input.asset,side:input.kind,chainId:this.options.manifest.chainId,policyVersion:policy.version.toString(),session:route.session});
    if(!admission.allowed||admission.expiresAt<=Date.now())throw new Error('ASSET_UNAVAILABLE');
    const asset=(await this.options.catalog.assets()).find(a=>a.address.toLowerCase()===input.asset.toLowerCase()&&a.chainId===this.options.manifest.chainId&&a.provider===route.provider);
    if(!asset?.active||!sessionAllows(asset.sessions[route.session],input.kind))throw new Error('ASSET_UNAVAILABLE');
    const code=await this.client.getCode({address:route.adapter});
    if(!code||keccak256(code)!==route.adapterCodeHash)throw new Error('ADAPTER_CODE_MISMATCH');
    const tokenIn=input.kind==='BUY'?manifest.settlement:input.asset,tokenOut=input.kind==='BUY'?input.asset:manifest.settlement;
    const amount=BigInt(input.amountInRaw);if(amount<=0n||amount>=(1n<<256n))throw new Error('INVALID_AMOUNT');
    const [routeHash,floor,expected,quote]=await Promise.all([
      this.client.readContract({address:route.adapter,abi:adapterAbi,functionName:'routeHash',args:[tokenIn,tokenOut]}),
      this.client.readContract({address:route.adapter,abi:adapterAbi,functionName:'independentFloor',args:[tokenIn,tokenOut,amount]}),
      this.client.readContract({address:route.adapter,abi:adapterAbi,functionName:'quote',args:[tokenIn,tokenOut,amount]}),
      this.client.simulateContract({address:route.quoter,abi:quoterAbi,functionName:'quoteExactInputSingle',args:[{tokenIn,tokenOut,amountIn:amount,fee:route.fee,sqrtPriceLimitX96:0n}]})]);
    if(quote.result[0]<floor||floor===0n)throw new Error('PRICE_UNAVAILABLE');
    const validUntil=Math.min(Date.now()+30000,admission.expiresAt);
    if(validUntil<=Date.now())throw new Error('ASSET_UNAVAILABLE');
    return {adapter:route.adapter,quoteId:crypto.randomUUID(),chainId:this.options.manifest.chainId,assetIn:tokenIn,assetOut:tokenOut,amountInRaw:input.amountInRaw,minAmountOutRaw:floor.toString(),feeRaw:(amount*BigInt(route.fee)/1_000_000n).toString(),priceImpactBps:expected>quote.result[0]?Number((expected-quote.result[0])*10000n/expected):0,validUntil:new Date(validUntil).toISOString(),routeHash,status:'available'};
  }
  private async signatures(action:ActionIntent,approvals:CollectedApproval[]){
    if(!approvals.length)throw new Error('APPROVAL_REQUIRED');
    const seen=new Set<string>(),out:Hex[]=[];
    for(const a of approvals){
      if(seen.has(a.signer.toLowerCase()))throw new Error('DUPLICATE_APPROVAL');seen.add(a.signer.toLowerCase());
      const check=await this.verifyActionSignature({action,signer:a.signer,signature:a.signature});
      if(!check.valid)throw new Error('INVALID_SIGNATURE');
      out.push(check.signatureType==='erc1271'?encodeAbiParameters([{type:'address'},{type:'bytes'}],[a.signer,a.signature]):a.signature);
    }
    return out;
  }
  async simulateAction(action:ActionIntent,approvals:CollectedApproval[]=[]){
    try {
      await this.registered(action.account);
      if(action.chainId!==await this.getChainId())throw new Error('WRONG_CHAIN');
      if(action.kind!=='PAYMENT'){
        const asset=action.kind==='BUY'?action.tokenOut:action.tokenIn;
        const route=this.options.manifest.routes.find(r=>r.asset.toLowerCase()===asset.toLowerCase());
        if(!route||route.adapter.toLowerCase()!==action.adapter.toLowerCase()||!this.options.marketGate)throw new Error('ASSET_UNAVAILABLE');
        const decision=await this.options.marketGate({account:action.account,actor:action.actor,asset,side:action.kind,chainId:action.chainId,policyVersion:action.policyVersion,session:route.session});
        if(!decision.allowed||decision.expiresAt<=Date.now())throw new Error('ASSET_UNAVAILABLE');
        const fresh=await this.quote({account:action.account,actor:action.actor,kind:action.kind,asset,amountInRaw:action.amountInRaw});
        if(fresh.assetIn.toLowerCase()!==action.tokenIn.toLowerCase()||fresh.assetOut.toLowerCase()!==action.tokenOut.toLowerCase()||fresh.routeHash.toLowerCase()!==action.routeHash.toLowerCase()||BigInt(action.minAmountOutRaw)<BigInt(fresh.minAmountOutRaw))throw new Error('TRADE_ADMISSION_CHANGED');
      }
      const sigs=await this.signatures(action,approvals);
      const data=encodeFunctionData({abi:accountAbi,functionName:action.kind==='PAYMENT'?'executePayment':'executeTrade',args:[actionMessage(action),sigs]});
      await this.client.call({account:action.actor,to:action.account,data});
      return {ok:true};
    }catch{return {ok:false,reason:'EXECUTION_VALIDATION_FAILED'};}
  }
  async prepareAction(action:ActionIntent,approvals:CollectedApproval[]=[]):Promise<PreparedTransaction>{
    const simulation=await this.simulateAction(action,approvals);if(!simulation.ok)throw new Error(simulation.reason);
    let admissionExpiry=Number.POSITIVE_INFINITY;
    if(action.kind!=='PAYMENT'){
      const asset=action.kind==='BUY'?action.tokenOut:action.tokenIn;
      const route=this.options.manifest.routes.find(r=>r.asset.toLowerCase()===asset.toLowerCase());
      if(!route||!this.options.marketGate)throw new Error('ASSET_UNAVAILABLE');
      const decision=await this.options.marketGate({account:action.account,actor:action.actor,asset,side:action.kind,chainId:action.chainId,policyVersion:action.policyVersion,session:route.session});
      if(!decision.allowed||decision.expiresAt<=Date.now())throw new Error('ASSET_UNAVAILABLE');
      admissionExpiry=decision.expiresAt;
    }
    const sigs=await this.signatures(action,approvals);
    const expiresAt=Math.min(Date.now()+30000,Number(action.deadline)*1000,admissionExpiry);
    if(expiresAt<=Date.now())throw new Error('ASSET_UNAVAILABLE');
    return {chainId:action.chainId,to:action.account,value:'0',data:encodeFunctionData({abi:accountAbi,functionName:action.kind==='PAYMENT'?'executePayment':'executeTrade',args:[actionMessage(action),sigs]}),actionHash:hashActionIntent(action),manifestVersion:this.options.manifest.version,simulation,expiresAt:new Date(expiresAt).toISOString()};
  }
  async prepareCancellation(action:ActionIntent,requester:Address,approvals:CollectedApproval[]=[]):Promise<PreparedTransaction>{
    const authority=await this.getAccountAuthority(action.account);
    let data:Hex;
    if(requester.toLowerCase()===authority.parent.toLowerCase())data=encodeFunctionData({abi:accountAbi,functionName:'cancelAction',args:[action.actionId]});
    else {
      if(requester.toLowerCase()!==action.actor.toLowerCase())throw new Error('NOT_AUTHORIZED');
      const approval=approvals.find(a=>a.signer.toLowerCase()===requester.toLowerCase());if(!approval)throw new Error('APPROVAL_REQUIRED');
      const [signature]=await this.signatures(action,[approval]);
      data=encodeFunctionData({abi:accountAbi,functionName:'cancelOwnAction',args:[actionMessage(action),signature!]});
    }
    await this.client.call({account:requester,to:action.account,data});
    return {chainId:action.chainId,to:action.account,value:'0',data,actionHash:hashActionIntent(action),manifestVersion:this.options.manifest.version,simulation:{ok:true},expiresAt:new Date(Date.now()+30000).toISOString()};
  }
  async confirmContinuityRequest(proof:ContinuityRequestProof):Promise<boolean>{
    try {
      await this.registered(proof.account);
      const authority=await this.getAccountAuthority(proof.account);
      if(authority.securityEpoch!==proof.securityEpoch||!proof.successor)return false;
      const module=proof.type==='incapacity'?await this.registeredIncapacity(proof.account):undefined;
      const target=module?.address??proof.account;
      const receipt=await this.client.getTransactionReceipt({hash:proof.transactionHash});
      const [block,finalized]=await Promise.all([this.client.getBlock({blockNumber:receipt.blockNumber}),this.client.getBlock({blockTag:'finalized'})]);
      if(receipt.status!=='success'||block.hash!==receipt.blockHash||finalized.number<receipt.blockNumber)return false;
      if(module){
        const caregiver=await this.client.readContract({address:module.address,abi:incapacityAbi,functionName:'caregiver'});
        if(caregiver.toLowerCase()!==proof.successor.toLowerCase())return false;
      }
      return receipt.logs.some(log=>{
        if(log.address.toLowerCase()!==target.toLowerCase())return false;
        try{
          if(module){const e=decodeEventLog({abi:incapacityAbi,data:log.data,topics:log.topics});return e.eventName==='Requested'&&e.args.id===BigInt(proof.chainCaseId)&&e.args.evidenceHash===proof.evidenceHash&&e.args.epoch===BigInt(proof.securityEpoch);}
          const e=decodeEventLog({abi:accountAbi,data:log.data,topics:log.topics});
          if(proof.type==='recovery')return e.eventName==='RecoveryStarted'&&e.args.id===BigInt(proof.chainCaseId)&&e.args.newParent.toLowerCase()===proof.successor!.toLowerCase();
          return e.eventName==='SuccessionRequested'&&e.args.id===BigInt(proof.chainCaseId)&&e.args.successor.toLowerCase()===proof.successor!.toLowerCase()&&e.args.planHash===proof.planHash&&e.args.evidenceHash===proof.evidenceHash;
        }catch{return false;}
      });
    }catch{return false;}
  }
  async confirmContinuityExecution(proof:ContinuityExecutionProof):Promise<boolean>{
    if(!proof.successor)return false;
    const account=proof.account; const successor=proof.successor;
    await this.registered(account);
    try {
      const module=proof.type==='incapacity'?await this.registeredIncapacity(account):undefined;
      const target=module?.address??account;
      const receipt=await this.client.getTransactionReceipt({hash:proof.transactionHash});
      // Sponsored passkey calls and other relayers may be the outer destination.
      // Only an exact event emitted by the pinned account/module proves execution.
      if(receipt.status!=='success')return false;
      if((await this.client.getBlock({blockNumber:receipt.blockNumber})).hash!==receipt.blockHash)return false;
      const finalized=await this.client.getBlock({blockTag:'finalized'});if(finalized.number<receipt.blockNumber)return false;
      return receipt.logs.some(log=>{
        if(log.address.toLowerCase()!==target.toLowerCase())return false;
        try {
          if(module){const event=decodeEventLog({abi:incapacityAbi,data:log.data,topics:log.topics});return event.eventName==='Executed'&&event.args.id===BigInt(proof.chainCaseId)&&event.args.caregiver.toLowerCase()===successor.toLowerCase();}
          const event=decodeEventLog({abi:accountAbi,data:log.data,topics:log.topics});
          if(proof.type==='recovery'&&event.eventName==='RecoveryExecuted')return event.args.id===BigInt(proof.chainCaseId)&&event.args.newParent.toLowerCase()===successor.toLowerCase();
          if(proof.type==='succession'&&event.eventName==='SuccessionExecuted')return event.args.id===BigInt(proof.chainCaseId)&&event.args.successor.toLowerCase()===successor.toLowerCase();
          return false;
        }catch{return false;}
      });
    }catch{return false;}
  }
  async inspectTransaction(hash:Hex,action?:ActionIntent):Promise<ChainReceipt>{
    if(!action)throw new Error('ACTION_REQUIRED');await this.registered(action.account);
    const base={hash,chainId:this.options.manifest.chainId};
    let tx;
    try{tx=await this.client.getTransaction({hash});}catch(error){if((error as Error).name.includes('TransactionNotFound'))return {...base,state:'unknown'};throw new Error('RPC_UNAVAILABLE');}
    if(tx.to?.toLowerCase()!==action.account.toLowerCase()||tx.value!==0n)throw new Error('TRANSACTION_MISMATCH');
    const decoded=decodeFunctionData({abi:accountAbi,data:tx.input});
    if(decoded.functionName!==(action.kind==='PAYMENT'?'executePayment':'executeTrade'))throw new Error('TRANSACTION_MISMATCH');
    const message=decoded.args![0] as ReturnType<typeof actionMessage>;
    const digest=hashTypedData({domain:actionDomain(action),types:ACTION_TYPES,primaryType:'Action',message});
    if(digest!==hashActionIntent(action))throw new Error('TRANSACTION_MISMATCH');
    let receipt;
    try{receipt=await this.client.getTransactionReceipt({hash});}catch(error){if((error as Error).name.includes('TransactionReceiptNotFound'))return {...base,state:'submitted',sender:tx.from};throw new Error('RPC_UNAVAILABLE');}
    const result={...base,sender:tx.from,blockNumber:receipt.blockNumber.toString(),blockHash:receipt.blockHash,actionHash:digest};
    if((await this.client.getBlock({blockNumber:receipt.blockNumber})).hash!==receipt.blockHash)return {...result,state:'reorged'};
    if(receipt.status==='reverted')return {...result,state:'reverted'};
    const found=receipt.logs.some(log=>{if(log.address.toLowerCase()!==action.account.toLowerCase())return false;try{const e=decodeEventLog({abi:accountAbi,data:log.data,topics:log.topics});return e.eventName==='ActionExecuted'&&e.args.actionId===action.actionId;}catch{return false;}});
    if(!found)throw new Error('ACTION_EVENT_MISSING');
    let finalized=false;
    try{const block=await this.client.getBlock({blockTag:'finalized'});finalized=block.number>=receipt.blockNumber;}catch{/* Unsupported finality does not imply success/finality. */}
    return {...result,state:finalized?'finalized':'included'};
  }
}
