import {expect,test} from 'bun:test';
import {encodeAbiParameters,encodeEventTopics,encodeFunctionData,keccak256,type Address} from 'viem';
import {VerifiedLiveChainGateway,type LiveFactoryV2} from './live-chain';
import {ReadRpcPool} from './rpc';
import {StewardFactoryV1Abi as factoryAbi} from './contracts.generated';
import {expectedV2ShellRuntimeCode} from '@steward/shared';

const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as Address;
const factory=a(50),v1=a(51),module=a(52),cowSettlement=a(53),stock=a(54),guard=a(55),relayer=a(56),account=a(57),token=a(58),parent=a(59);
const code='0x6000' as const,shellCode=expectedV2ShellRuntimeCode(v1,module),hash=keccak256(code),shellHash=keccak256(shellCode);
const txHash=`0x${'12'.repeat(32)}` as const,blockHash=`0x${'34'.repeat(32)}` as const,manifestHash=`0x${'56'.repeat(32)}` as const;
function fixture(){
 const pins:LiveFactoryV2={address:factory,runtimeCodeHash:hash,accountRuntimeCodeHash:shellHash,v1Implementation:v1,v1ImplementationCodeHash:hash,cowModule:module,cowModuleCodeHash:hash,settlement:cowSettlement,settlementCodeHash:hash,stockToken:stock,stockTokenCodeHash:hash,priceGuard:guard,priceGuardCodeHash:hash,relayer,relayerCodeHash:hash,maxFeeBps:'500'};
 const gateway=new VerifiedLiveChainGateway({rpc:new ReadRpcPool(['http://127.0.0.1:1'],31337),manifest:{chainId:31337,version:'v2-local-fixture',accounts:[],routes:[],factoryV2:pins}});
 let modulePointer=module,invalidCode=false,canonical=true,receiptTo=factory,fresh=false;
 const config={settlement:token,period:86400n,anchor:0n,paymentLimit:100n,buyLimit:1000n,reserve:0n,perPayment:50n,perBuy:500n,perSell:500n,exceptionQuorum:2n,approvedTokens:[stock],paymentRecipients:[],exceptionSigners:[a(61),a(62)],guardians:[a(63),a(64),a(65)],approvedAdapters:[],sellCapTokens:[],sellCaps:[],continuityReviewer:a(66),continuitySuccessor:a(67),continuityPlanHash:manifestHash};
 const input=encodeFunctionData({abi:factoryAbi,functionName:'createAccount',args:[parent,config]});
 const topics=encodeEventTopics({abi:factoryAbi,eventName:'AccountCreated',args:{account,parent}});
 Object.assign(gateway.client,{
  getCode:async({address}:{address:Address})=>invalidCode&&address===module?'0x6002':address===account?shellCode:code,
  call:async()=>({}),
  getBlock:async(input?:{blockTag?:string})=>input?.blockTag==='finalized'?{number:12n,hash:blockHash}:{number:12n,hash:canonical?blockHash:txHash,timestamp:100n},
  getTransactionReceipt:async()=>({status:'success',to:receiptTo,blockNumber:12n,blockHash,logs:[{address:factory,topics,data:encodeAbiParameters([{type:'bytes32'}],[manifestHash])}]}),
  getTransaction:async()=>({input,value:0n}),
  readContract:async({address,functionName}:{address:Address;functionName:string})=>{
   switch(functionName){
    case 'v1Implementation':return v1;
    case 'cowModule':return address===factory?module:modulePointer;
    case 'accountRuntimeCodeHash':return fresh?`0x${'00'.repeat(32)}`:shellHash;
    case 'accountCount':return fresh?0n:1n;
    case 'settlement':return cowSettlement;
    case 'stockToken':return stock;
    case 'priceGuard':return guard;
    case 'relayer':return relayer;
    case 'maxFeeBps':return 500n;
    case 'deploymentChainId':return 31337n;
    case 'isStewardAccount':return true;
    case 'MANIFEST':return manifestHash;
    case 'policy':return [token,86400n,0n,100n,1000n,0n,50n,500n,500n,2n,1n];
    case 'periodStart':return 0n;
    case 'symbol':return 'MOCK';
    case 'paymentSpent':return 20n;
    case 'buySpent':return 100n;
    case 'budgetStatus':return [300n,200n,50n];
    default:throw Error(`Unexpected ${functionName}`);
   }
  }
 });
 gateway.getAccountAuthority=async()=>({parent,policyVersion:'1',securityEpoch:'1'});
 return {gateway,config,setFresh:(value:boolean)=>{fresh=value;},setModulePointer:(value:Address)=>{modulePointer=value;},setInvalidCode:(value:boolean)=>{invalidCode=value;},setCanonical:(value:boolean)=>{canonical=value;},setReceiptTo:(value:Address)=>{receiptTo=value;}};
}

test('fresh factory prepares its first account using reviewed shell artifact before any account runtime exists',async()=>{
 const f=fixture();f.setFresh(true);
 const policy=Object.fromEntries(Object.entries(f.config).map(([key,value])=>[key,typeof value==='bigint'?value.toString():value]));
 const prepared=await f.gateway.prepareDeployment(parent,policy,'v2');
 expect(prepared.to).toBe(factory);
 f.setFresh(false);
 expect((await f.gateway.confirmDeployment({transactionHash:txHash,parent})).account).toBe(account);
});

test('V2 finalized factory receipt registers once and budget combines V1 spent with CoW completed and reserved',async()=>{
 const f=fixture();
 const first=await f.gateway.confirmDeployment({transactionHash:txHash,parent});
 expect(first.account).toBe(account);
 expect(first.implementation).toBe(v1);
 expect(f.gateway.options.manifest.accounts).toHaveLength(1);
 expect((await f.gateway.confirmDeployment({transactionHash:txHash,parent})).account).toBe(account);
 expect(f.gateway.options.manifest.accounts).toHaveLength(1);
 expect(await f.gateway.getBudget(account)).toMatchObject({remainingRaw:'80',buyBudget:{limitRaw:'1000',chargedRaw:'150',pendingRaw:'200',availableRaw:'650'}});
});

test('V2 enrollment rejects changed module code, changed shell pointer, wrong factory and noncanonical receipt',async()=>{
 const f=fixture();f.setInvalidCode(true);
 await expect(f.gateway.confirmDeployment({transactionHash:txHash,parent})).rejects.toThrow('FACTORY_V2_CODE_MISMATCH');
 f.setInvalidCode(false);f.setModulePointer(a(99));
 await expect(f.gateway.confirmDeployment({transactionHash:txHash,parent})).rejects.toThrow('ACCOUNT_COMPONENT_MISMATCH');
 f.setModulePointer(module);f.setReceiptTo(a(99));
 await expect(f.gateway.confirmDeployment({transactionHash:txHash,parent})).rejects.toThrow();
 f.setReceiptTo(factory);f.setCanonical(false);
 await expect(f.gateway.confirmDeployment({transactionHash:txHash,parent})).rejects.toThrow('DEPLOYMENT_NOT_FINALIZED');
});
