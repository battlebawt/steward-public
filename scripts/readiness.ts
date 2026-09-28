/** Read-only; this never turns on production or deploys contracts. */
import { readFile } from 'node:fs/promises';
import { createPublicClient, custom, parseAbi, isAddress, keccak256, type Hex, type Address } from 'viem';
import { ReadRpcPool } from '../server/src/integrations/rpc';
export async function checkReadiness(manifest: any, rpc?: ReadRpcPool): Promise<string[]> {
  const failures: string[] = [];
  for(const name of ['StewardAccountV1','StewardFactoryV1','StewardPasskeySignerV1']){
    try{const artifact=JSON.parse(await readFile(`contracts/out/${name}.sol/${name}.json`,'utf8'));const runtime=artifact.deployedBytecode?.object;const bytes=typeof runtime==='string'?(runtime.length-2)/2:0;if(!bytes||bytes>24576)failures.push(`${name}: runtime ${bytes} bytes exceeds deployment limit or artifact is invalid`);}
    catch{failures.push(`${name}: compiled deployment artifact unavailable`);}
  }

  for (const gate of ['G1_operating_market','G2_asset_integration','G3_control_security','G4_continuity','G5_operations']) {
    if (manifest.gates?.[gate]?.approved !== true || typeof manifest.gates?.[gate]?.evidence !== 'string' || manifest.gates[gate].evidence.trim().length < 10) failures.push(`${gate}: evidence/approval missing`);
  }
  if (!Number.isSafeInteger(manifest.chainId) || manifest.chainId <= 0) failures.push('chainId: missing');
  if (!isAddress(manifest.factory ?? '')) failures.push('factory: missing');
  if (!/^0x[\da-f]{64}$/i.test(manifest.accountRuntimeCodeHash ?? '')) failures.push('accountRuntimeCodeHash: missing');
  if (!Array.isArray(manifest.assets) || !manifest.assets.length) failures.push('assets: no reviewed routes');
  for (const asset of manifest.assets ?? []) {
    if(typeof asset.issuer!=='string'||asset.issuer.trim().length<2)failures.push(`asset ${asset.symbol ?? '?'}: issuer identity missing`);
    // Route approval is scoped to a particular customer market. A global G1
    // approval cannot accidentally release this asset in every country.
    const markets=asset.markets;
    if(!Array.isArray(markets)||markets.length===0)failures.push(`asset ${asset.symbol ?? '?'}: no reviewed customer market`);
    else {
      const seen=new Set<string>();
      for(const market of markets){
        const country=market?.countryCode;
        if(typeof country!=='string'||!/^([A-Z]{2})$/.test(country)||seen.has(country)){
          failures.push(`asset ${asset.symbol ?? '?'}: customer market code missing or duplicated`);continue;
        }
        seen.add(country);
        if(market.approved!==true||typeof market.evidence!=='string'||market.evidence.trim().length<10||typeof market.eligibilitySource!=='string'||market.eligibilitySource.trim().length<10||typeof market.sessionSource!=='string'||market.sessionSource.trim().length<10)failures.push(`asset ${asset.symbol ?? '?'}: ${country} market approval or live admission sources missing`);
        // RHJ's current issuer restrictions include these markets. The public
        // list is longer and must still be checked during each market review.
        if(asset.issuer==='RHJ'&&['US','CA','GB','CH'].includes(country))failures.push(`asset ${asset.symbol ?? '?'}: RHJ ${country} is issuer-restricted`);
      }
    }
    for (const key of ['token','feed','settlementFeed','adapter']) if (!isAddress(asset[key] ?? '')) failures.push(`asset ${asset.symbol ?? '?'}: ${key} missing`);
    const hasSequencer = typeof asset.sequencerFeed === 'string' && isAddress(asset.sequencerFeed) && !/^0x0{40}$/i.test(asset.sequencerFeed);
    if (asset.sequencerFeed !== undefined && !isAddress(asset.sequencerFeed)) failures.push(`asset ${asset.symbol ?? '?'}: sequencerFeed invalid`);
    if (!(asset.maxPriceAge > 0) || (hasSequencer ? !(asset.sequencerGrace > 0) : asset.sequencerGrace !== 0)) failures.push(`asset ${asset.symbol ?? '?'}: timing configuration missing`);
    if (!asset.termsVersion || !asset.proxyReview) failures.push(`asset ${asset.symbol ?? '?'}: terms/proxy review missing`);
  }
  if (!isAddress(manifest.implementation ?? '') || !/^0x[\da-f]{64}$/i.test(manifest.implementationCodeHash ?? '')) failures.push('implementation: reviewed address/hash missing');
  if (rpc && isAddress(manifest.factory ?? '')) {
    try {
      if(rpc.chainId!==manifest.chainId)throw Error('WRONG_CHAIN');
      const client=createPublicClient({transport:custom({request:({method,params})=>rpc.request(method,params as unknown[]??[])})});
      if(await client.getChainId()!==manifest.chainId)throw Error('WRONG_CHAIN');
      const block=await client.getBlock({blockTag:'finalized'});
      const pin=async(label:string,address:unknown,hash:unknown)=>{
        if(typeof address!=='string'||!isAddress(address)||typeof hash!=='string'||!/^0x[\da-f]{64}$/i.test(hash)){failures.push(`${label}: reviewed address/hash missing`);return false;}
        const code=await client.getCode({address,blockNumber:block.number});
        if(!code||code==='0x'||keccak256(code).toLowerCase()!==hash.toLowerCase()){failures.push(`${label}: bytecode mismatch`);return false;}return true;
      };
      await pin('factory',manifest.factory,manifest.factoryCodeHash);
      if(await pin('implementation',manifest.implementation,manifest.implementationCodeHash)){
        const target=await client.readContract({address:manifest.factory,abi:parseAbi(['function implementation() view returns(address)']),functionName:'implementation',blockNumber:block.number});
        if(target.toLowerCase()!==manifest.implementation.toLowerCase())failures.push('factory: implementation pointer mismatch');
        const clone=`0x363d3d373d3d3d363d73${manifest.implementation.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3` as Hex;
        if(keccak256(clone)!==manifest.accountRuntimeCodeHash?.toLowerCase())failures.push('accountRuntimeCodeHash: clone template mismatch');
      }
      for(const asset of manifest.assets??[]){
        const label=`asset ${asset.symbol??'?'}`;
        let pins=true;
        for(const key of ['token','settlement','feed','settlementFeed','adapter','source','venue','router','quoter'])pins=await pin(`${label} ${key}`,asset[key],asset[`${key}CodeHash`])&&pins;
        if (asset.sequencerFeed && !/^0x0{40}$/i.test(asset.sequencerFeed)) pins=await pin(`${label} sequencerFeed`,asset.sequencerFeed,asset.sequencerFeedCodeHash)&&pins;
        if(!pins)continue;
        const adapterAbi=parseAbi(['function settlement() view returns(address)','function source() view returns(address)','function venue() view returns(address)','function maxPriceAge() view returns(uint256)','function routeHash(address,address) view returns(bytes32)','function independentFloor(address,address,uint256) view returns(uint256)']);
        for(const key of ['settlement','source','venue'] as const){const value=await client.readContract({address:asset.adapter,abi:adapterAbi,functionName:key,blockNumber:block.number});if(value.toLowerCase()!==asset[key].toLowerCase())failures.push(`${label}: adapter ${key} mismatch`);}
        const maxAge=await client.readContract({address:asset.adapter,abi:adapterAbi,functionName:'maxPriceAge',blockNumber:block.number});if(maxAge!==BigInt(asset.maxPriceAge))failures.push(`${label}: adapter heartbeat mismatch`);
        const sourceAbi=parseAbi(['function feedFor(address) view returns(address)','function sequencerFeed() view returns(address)','function sequencerGracePeriod() view returns(uint64)','function price(address) view returns(uint256,uint8,uint256,bool)']);
        const sequencer=await client.readContract({address:asset.source,abi:sourceAbi,functionName:'sequencerFeed',blockNumber:block.number});
        const grace=await client.readContract({address:asset.source,abi:sourceAbi,functionName:'sequencerGracePeriod',blockNumber:block.number});
        if(sequencer.toLowerCase()!==(asset.sequencerFeed??'0x0000000000000000000000000000000000000000').toLowerCase()||grace!==BigInt(asset.sequencerGrace))failures.push(`${label}: sequencer configuration mismatch`);
        for(const [token,feed] of [[asset.token,asset.feed],[asset.settlement,asset.settlementFeed]])if((await client.readContract({address:asset.source,abi:sourceAbi,functionName:'feedFor',args:[token],blockNumber:block.number})).toLowerCase()!==feed.toLowerCase())failures.push(`${label}: feed mapping mismatch`);
        for(const token of [asset.token,asset.settlement]){const [value,decimals,updatedAt,paused]=await client.readContract({address:asset.source,abi:sourceAbi,functionName:'price',args:[token],blockNumber:block.number});if(paused||value===0n||decimals>18||updatedAt===0n||updatedAt>block.timestamp||block.timestamp-updatedAt>maxAge)failures.push(`${label}: source price unavailable`);}
        const venueAbi=parseAbi(['function router() view returns(address)','function approvedCaller(address) view returns(bool)','function feeFor(address,address) view returns(uint24)']);
        const router=await client.readContract({address:asset.venue,abi:venueAbi,functionName:'router',blockNumber:block.number});
        if(router.toLowerCase()!==asset.router.toLowerCase()||!await client.readContract({address:asset.venue,abi:venueAbi,functionName:'approvedCaller',args:[asset.adapter],blockNumber:block.number}))failures.push(`${label}: venue authorization mismatch`);
        for(const [tokenIn,tokenOut] of [[asset.settlement,asset.token],[asset.token,asset.settlement]] as [Address,Address][]){
          const fee=await client.readContract({address:asset.venue,abi:venueAbi,functionName:'feeFor',args:[tokenIn,tokenOut],blockNumber:block.number});
          if(fee!==asset.fee)failures.push(`${label}: venue fee mismatch`);
          const route=await client.readContract({address:asset.adapter,abi:adapterAbi,functionName:'routeHash',args:[tokenIn,tokenOut],blockNumber:block.number});
          if(route===`0x${'00'.repeat(32)}`)failures.push(`${label}: route missing`);
        }
      }
      if((await client.getBlock({blockNumber:block.number})).hash!==block.hash)failures.push('RPC: finalized block changed during verification');
    } catch { failures.push('RPC: finalized deployment/configuration validation failed'); }
  } else failures.push('RPC: not checked');
  return failures;
}
if (import.meta.main) {
  const path = process.argv[2] ?? 'config/release-gates.example.json';
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  const rpc = process.env.STEWARD_RPC_URL ? new ReadRpcPool([process.env.STEWARD_RPC_URL], manifest.chainId) : undefined;
  const failures = await checkReadiness(manifest, rpc);
  console.log(JSON.stringify({ ready: failures.length === 0, failures }, null, 2));
  process.exitCode = failures.length ? 1 : 0;
}
