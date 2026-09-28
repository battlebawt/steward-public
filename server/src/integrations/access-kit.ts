/** Portable public recovery information. Never signs, broadcasts, or reads wallet keys. */
import { createPublicClient, custom, encodeFunctionData, keccak256, type Address, type Hex } from 'viem';
import { AddressSchema } from '@steward/shared';
import { LiveManifestSchema } from './manifest';
import { StewardAccountV1Abi, StewardPasskeySignerV1Abi, StewardIncapacityModuleV1Abi } from './contracts.generated';
import { managementCall } from './management';
import { continuityCall } from './continuity';
import { ReadRpcPool } from './rpc';

export function buildAccessKit(input:unknown,address:string){
  const manifest=LiveManifestSchema.parse(input),account=AddressSchema.parse(address);
  const entry=manifest.accounts.find(a=>a.address===account);
  if(!entry)throw Error('ACCOUNT_NOT_IN_REVIEWED_MANIFEST');
  if(!entry.implementation||!entry.implementationCodeHash)throw Error('IMPLEMENTATION_PINS_REQUIRED');
  const cloneCode=`0x363d3d373d3d3d363d73${entry.implementation.slice(2)}5af43d82803e903d91602b57fd5bf3` as Hex;
  if(keccak256(cloneCode)!==entry.runtimeCodeHash)throw Error('ACCOUNT_CLONE_PIN_MISMATCH');
  const module=manifest.incapacityModules?.find(m=>m.account===account);
  return {
    format:'steward-independent-access-v2' as const,createdAt:new Date().toISOString(),
    chainId:manifest.chainId,account,manifestVersion:manifest.version,
    deploymentBlock:entry.deploymentBlock,expectedRuntimeCodeHash:entry.runtimeCodeHash,
    implementation:{address:entry.implementation,runtimeCodeHash:entry.implementationCodeHash},
    incapacityModule:module?{address:module.address,runtimeCodeHash:module.runtimeCodeHash}:null,
    contracts:{account:{address:account,abi:StewardAccountV1Abi},passkeySigner:{abi:StewardPasskeySignerV1Abi},incapacity:{address:module?.address??null,abi:StewardIncapacityModuleV1Abi}},
    verification:{status:'not-checked' as string,blockNumber:null as string|null,blockHash:null as Hex|null},
    instructions:[
      'Retain this file outside Steward together with independently reviewed chain, account, implementation and module pins. A server export alone is not independent trust.',
      'Verify runtime hashes on the intended chain before signing. This snapshot does not establish current ownership, balances, pending cases or provider eligibility.',
      'An EOA parent calls withdraw(token,amount,to), revokeDelegate(delegate), or pauseDelegatedSpending() directly on the account. Amounts use raw integer units; gas is required.',
      'An enrolled guardian calls startRecovery(newParent), other enrolled guardians call approveRecovery(id), and executeRecovery() is available only after the on-chain quorum/delay. Read recovery state and securityEpoch first. Parent can cancelRecovery().',
      'Passkey parents authorize through the enrolled signer execute(target,value,data,nonce,deadline,assertion). Retain access to the enrolled RP/origin and authenticator; a passkey alone is not an arbitrary-origin offline signer. If unavailable, use enrolled guardian recovery.',
      'Succession/incapacity need enrolled reviewers, evidence commitments, acceptance/quorum and contract delays. Human/legal evidence validity is not established by this export.',
      'Never share seed phrases, private keys, service encryption keys or backup keys. This file contains public metadata only.'
    ]
  };
}
export type AccessKit=ReturnType<typeof buildAccessKit>;
export async function verifyAccessKit(kit:AccessKit,rpc:ReadRpcPool){
  if(rpc.chainId!==kit.chainId)throw Error('WRONG_CHAIN');
  const client=createPublicClient({transport:custom({request:({method,params})=>rpc.request(method,params as unknown[]??[])})});
  if(await client.getChainId()!==kit.chainId)throw Error('WRONG_CHAIN');
  const block=await client.getBlock({blockTag:'finalized'});
  const checks=[{address:kit.account,hash:kit.expectedRuntimeCodeHash}, {address:kit.implementation.address,hash:kit.implementation.runtimeCodeHash},...(kit.incapacityModule?[{address:kit.incapacityModule.address,hash:kit.incapacityModule.runtimeCodeHash}]:[])];
  for(const pin of checks){const code=await client.getCode({address:pin.address,blockNumber:block.number});if(!code||keccak256(code)!==pin.hash)throw Error('ACCESS_KIT_CODE_MISMATCH');}
  if(kit.incapacityModule){
    const [enrolled,target]=await Promise.all([
      client.readContract({address:kit.account,abi:StewardAccountV1Abi,functionName:'incapacityModule',blockNumber:block.number}),
      client.readContract({address:kit.incapacityModule.address,abi:StewardIncapacityModuleV1Abi,functionName:'account',blockNumber:block.number})]);
    if(enrolled.toLowerCase()!==kit.incapacityModule.address||target.toLowerCase()!==kit.account)throw Error('ACCESS_KIT_MODULE_MISMATCH');
  }
  const canonical=await client.getBlock({blockNumber:block.number});if(canonical.hash!==block.hash)throw Error('ACCESS_KIT_REORG');
  return {...kit,verification:{status:'verified-at-finalized-block',blockNumber:block.number.toString(),blockHash:block.hash}};
}
/** Unsigned, unsimulated calls for an independent wallet; not authority or approval. */
export function accessKitCall(kit:AccessKit,kind:'management'|'continuity',input:unknown){
  const call=kind==='management'?{...managementCall(input),target:'account'}:continuityCall(input);
  const to=call.target==='account'?kit.account:kit.incapacityModule?.address;
  if(!to)throw Error('INCAPACITY_MODULE_PIN_REQUIRED');
  const data=encodeFunctionData({abi:call.target==='account'?StewardAccountV1Abi:StewardIncapacityModuleV1Abi,functionName:call.method,args:call.args} as any);
  return {chainId:kit.chainId,to:to as Address,value:'0',data,simulation:'not-performed',broadcasted:false};
}
