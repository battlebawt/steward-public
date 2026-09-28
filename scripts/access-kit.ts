/** Export a public independent access kit without signing or broadcasting. */
import { readFile, writeFile } from 'node:fs/promises';
import { buildAccessKit,verifyAccessKit } from '../server/src/integrations/access-kit';
import { ReadRpcPool } from '../server/src/integrations/rpc';
export {buildAccessKit,verifyAccessKit,accessKitCall} from '../server/src/integrations/access-kit';
if(import.meta.main){
  const [manifestPath,account,destination,flag]=process.argv.slice(2);
  if(!manifestPath||!account||!destination||(flag!==undefined&&flag!=='--verify'))throw Error('Usage: bun scripts/access-kit.ts LIVE_MANIFEST ACCOUNT NEW_OUTPUT.json [--verify]');
  let kit=buildAccessKit(JSON.parse(await readFile(manifestPath,'utf8')),account);
  if(flag==='--verify'){
    const url=process.env.STEWARD_RPC_URL;if(!url)throw Error('STEWARD_RPC_URL_REQUIRED');
    kit=await verifyAccessKit(kit,new ReadRpcPool([url,...(process.env.STEWARD_RPC_FALLBACK_URL?[process.env.STEWARD_RPC_FALLBACK_URL]:[])],kit.chainId));
  }
  await writeFile(destination,JSON.stringify(kit,null,2),{flag:'wx',mode:0o600});
  console.log(JSON.stringify({status:'written',verification:kit.verification.status,containsSigningKeys:false}));
}
