import {test,expect} from 'bun:test';
import {keccak256,decodeFunctionData,type Hex} from 'viem';
import {buildAccessKit,accessKitCall,verifyAccessKit} from './access-kit';
import {ReadRpcPool} from '../server/src/integrations/rpc';
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as const;
const clone=`0x363d3d373d3d3d363d73${a(2).slice(2)}5af43d82803e903d91602b57fd5bf3` as Hex;
const manifest={chainId:31337,version:'test',accounts:[{address:a(1),runtimeCodeHash:keccak256(clone),settlement:a(3),deploymentBlock:'2',implementation:a(2),implementationCodeHash:keccak256('0x6000')}],routes:[]};
test('portable access kit uses current manifest pins and excludes unrelated roster',()=>{
 const kit=buildAccessKit({...manifest,accounts:[...manifest.accounts,{...manifest.accounts[0],address:a(9)}]},a(1));
 expect(kit.manifestVersion).toBe('test');expect(kit.expectedRuntimeCodeHash).toBe(keccak256(clone));expect(kit.verification.status).toBe('not-checked');expect(JSON.stringify(kit)).not.toContain(a(9));
 const call=accessKitCall(kit,'management',{operation:'withdraw',token:a(3),amount:'9007199254740993000',recipient:a(4)});
 expect(call.to).toBe(a(1));expect(call.broadcasted).toBe(false);
 const decoded=decodeFunctionData({abi:kit.contracts.account.abi,data:call.data});expect(decoded.functionName).toBe('withdraw');expect(decoded.args).toEqual([a(3),9007199254740993000n,a(4)]);
 expect(()=>accessKitCall(kit,'management',{operation:'execute',target:a(9),data:'0x'})).toThrow();
 expect(()=>buildAccessKit(manifest,a(8))).toThrow('ACCOUNT_NOT_IN');
 expect(()=>buildAccessKit({...manifest,accounts:[{...manifest.accounts[0],runtimeCodeHash:keccak256('0x6000')}]},a(1))).toThrow('CLONE_PIN');
});
test('access kit verification binds code to a finalized canonical block and rejects mismatches',async()=>{
 let wrongCode=false,reorg=false;let numberReads=0;
 const hash=`0x${'11'.repeat(32)}`,other=`0x${'22'.repeat(32)}`;
 const rpc=new ReadRpcPool(['http://127.0.0.1:1'],31337);
 rpc.request=async(method:string,params:unknown[]=[])=>{
  if(method==='eth_chainId')return '0x7a69' as any;
  if(method==='eth_getBlockByNumber'){if(params[0]!=='finalized')numberReads++;return {number:'0xa',hash:reorg&&params[0]!=='finalized'?other:hash,timestamp:'0x64'} as any;}
  if(method==='eth_getCode'){expect(params[1]).toBe('0xa');return (wrongCode?'0x6001':params[0]===a(1)?clone:'0x6000') as any;}
  throw Error('Unexpected RPC');
 };
 const kit=buildAccessKit(manifest,a(1));expect((await verifyAccessKit(kit,rpc)).verification.blockNumber).toBe('10');expect(numberReads).toBe(1);
 wrongCode=true;await expect(verifyAccessKit(kit,rpc)).rejects.toThrow('CODE_MISMATCH');
 wrongCode=false;reorg=true;await expect(verifyAccessKit(kit,rpc)).rejects.toThrow('REORG');
});
