/** Disposable local Anvil enrollment proof. No public RPC, keys or assets. */
import {readFile} from 'node:fs/promises';
import {createPublicClient,createWalletClient,http,keccak256,type Address,type Hex} from 'viem';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {foundry} from 'viem/chains';
import {expectedV2ShellRuntimeCodeHash,COW_KIND_SELL,COW_BALANCE_ERC20,cowOrderDigest,V2_COW_ORDER_ABI,contractCowOrder} from '@steward/shared';
import {VerifiedLiveChainGateway,type LiveFactoryV2} from '../server/src/integrations/live-chain';
import {ReadRpcPool} from '../server/src/integrations/rpc';

const port=20000+Math.floor(Math.random()*10000),url=`http://127.0.0.1:${port}`;
const anvil=Bun.spawn(['anvil','--host','127.0.0.1','--port',String(port),'--chain-id','31337','--silent'],{stdout:'pipe',stderr:'pipe'});
const parent=privateKeyToAccount(generatePrivateKey());
const client=createPublicClient({chain:foundry,transport:http(url)});
const wallet=createWalletClient({account:parent,chain:foundry,transport:http(url)});
const artifact=async(name:string)=>JSON.parse(await readFile(`contracts/out/${name.startsWith('V2Fixture')?'StewardV2CowIntegration.t.sol':`${name}.sol`}/${name}.json`,'utf8')) as {abi:any;bytecode:{object:Hex}};
async function rpc(method:string,params:unknown[]){const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});const body=await response.json() as {result?:unknown;error?:{message?:string}};if(body.error)throw Error(body.error.message??method);return body.result;}
async function mined(hash:Hex){const receipt=await client.waitForTransactionReceipt({hash});if(receipt.status!=='success')throw Error(`Reverted ${hash}`);return receipt;}
async function deploy(name:string,args:unknown[]){const a=await artifact(name);const receipt=await mined(await wallet.deployContract({abi:a.abi,bytecode:a.bytecode.object,args}));if(!receipt.contractAddress)throw Error(`${name} missing address`);return {address:receipt.contractAddress,abi:a.abi};}
async function pin(address:Address){const code=await client.getCode({address});if(!code)throw Error(`Missing code ${address}`);return keccak256(code);}
try{
 let ready=false;for(let attempt=0;attempt<100;attempt++){try{if(await client.getChainId()===31337){ready=true;break;}}catch{}await Bun.sleep(100);}if(!ready)throw Error('Local Anvil did not start');
 await rpc('anvil_setBalance',[parent.address,'0x3635c9adc5dea00000']);
 const token=await deploy('MockStewardToken',['Local mock settlement token','MOCK',6]);
 const stock=await deploy('MockStewardToken',['Local mock stock token','MSTK',6]);
 const settlement=await deploy('V2FixtureSettlement',[]);
 const guard=await deploy('V2FixtureGuard',[]);
 const cow=await deploy('StewardCowV2Module',[settlement.address,stock.address,guard.address,500n]);
 const factory=await deploy('StewardFactoryV2Prototype',[cow.address]);
 const v1=await client.readContract({address:factory.address,abi:factory.abi,functionName:'v1Implementation'}) as Address;
 const module=await client.readContract({address:factory.address,abi:factory.abi,functionName:'cowModule'}) as Address;
 const relayer=await client.readContract({address:module,abi:(await artifact('StewardCowV2Module')).abi,functionName:'relayer'}) as Address;
 const signers=Array.from({length:2},()=>privateKeyToAccount(generatePrivateKey()).address);
 const guardians=Array.from({length:3},()=>privateKeyToAccount(generatePrivateKey()).address);
 const config={settlement:token.address,period:86400n,anchor:0n,paymentLimit:1000n,buyLimit:1000n,reserve:0n,perPayment:100n,perBuy:100n,perSell:100n,exceptionQuorum:2n,approvedTokens:[stock.address],paymentRecipients:[],exceptionSigners:signers,guardians,approvedAdapters:[],sellCapTokens:[],sellCaps:[],continuityReviewer:privateKeyToAccount(generatePrivateKey()).address,continuitySuccessor:privateKeyToAccount(generatePrivateKey()).address,continuityPlanHash:keccak256('0x01')};
 if(await client.readContract({address:factory.address,abi:factory.abi,functionName:'accountCount'})!==0n)throw Error('Factory was not fresh');
 const accountRuntimeCodeHash=expectedV2ShellRuntimeCodeHash(v1,module);
 const pins:LiveFactoryV2={address:factory.address,runtimeCodeHash:await pin(factory.address),accountRuntimeCodeHash,v1Implementation:v1,v1ImplementationCodeHash:await pin(v1),cowModule:module,cowModuleCodeHash:await pin(module),settlement:settlement.address,settlementCodeHash:await pin(settlement.address),stockToken:stock.address,stockTokenCodeHash:await pin(stock.address),priceGuard:guard.address,priceGuardCodeHash:await pin(guard.address),relayer,relayerCodeHash:await pin(relayer),maxFeeBps:'500'};
 const gateway=new VerifiedLiveChainGateway({rpc:new ReadRpcPool([url],31337),manifest:{chainId:31337,version:'v2-local-fixture',accounts:[],routes:[],factoryV2:pins}});
 const policy=Object.fromEntries(Object.entries(config).map(([key,value])=>[key,typeof value==='bigint'?value.toString():value])) as Record<string,unknown>;
 const prepared=await gateway.prepareDeployment(parent.address,policy,'v2');
 if(prepared.to.toLowerCase()!==factory.address.toLowerCase()||prepared.value!=='0')throw Error('Wrong prepared V2 call');
 const hash=await wallet.sendTransaction({to:prepared.to,data:prepared.data,value:0n});
 await mined(hash);await rpc('anvil_mine',['0x40','0x0']);
 const deployed=await gateway.confirmDeployment({transactionHash:hash,parent:parent.address});
 if(await client.readContract({address:factory.address,abi:factory.abi,functionName:'accountCount'})!==1n)throw Error('First account was not enrolled');
 const block=await client.getBlock();
 const order={sellToken:token.address,buyToken:stock.address,receiver:deployed.account,sellAmount:'100',buyAmount:'95',validTo:String(block.timestamp+600n),appData:keccak256('0x01'),feeAmount:'0',kind:COW_KIND_SELL,partiallyFillable:false as const,sellTokenBalance:COW_BALANCE_ERC20,buyTokenBalance:COW_BALANCE_ERC20};
 const localDigest=cowOrderDigest(order,31337,settlement.address);
 const chainDigest=await client.readContract({address:deployed.account,abi:V2_COW_ORDER_ABI,functionName:'orderDigest',args:[contractCowOrder(order)]});
 if(localDigest!==chainDigest)throw Error('Independent CoW order digest differs from shell');
 if(deployed.implementation.toLowerCase()!==v1.toLowerCase())throw Error('Wrong V1 implementation');
 if((await gateway.confirmDeployment({transactionHash:hash,parent:parent.address})).account!==deployed.account)throw Error('Receipt retry changed account');
 const budget=await gateway.getBudget(deployed.account);
 if(budget.buyBudget?.availableRaw!=='1000'||budget.buyBudget?.pendingRaw!=='0')throw Error('V2 budget read failed');
 console.log(JSON.stringify({mode:'local-anvil-only',chainId:31337,account:deployed.account,factory:factory.address,receipt:hash,checked:['fresh factory','fixed component pins','prepared call','finalized receipt','idempotent registration','combined budget','independent order digest']}));
}catch(error){console.error((error as {shortMessage?:string;details?:string}).shortMessage??String(error).slice(0,500));if((error as {details?:string}).details)console.error((error as {details:string}).details.slice(0,500));process.exitCode=1;}
finally{anvil.kill();await anvil.exited;}
