import { readFile,writeFile } from 'node:fs/promises';
const names=['StewardAccountV1','StewardFactoryV1','StewardTradeAdapterV1','StewardIncapacityModuleV1','StewardPasskeySignerV1'];
let signerBytecode='';
const shell=JSON.parse(await readFile('contracts/out/StewardAccountV2Prototype.sol/StewardAccountV2Prototype.json','utf8'));
const shellRefs=shell.deployedBytecode.immutableReferences as Record<string,Array<{start:number;length:number}>>;
if(Object.keys(shellRefs).sort().join(',')!=='58811,58813'||shellRefs['58811']?.some(r=>r.length!==32)||shellRefs['58813']?.some(r=>r.length!==32))throw Error('V2 shell immutable layout changed; review and update the pin generator');
const cowModule=JSON.parse(await readFile('contracts/out/StewardCowV2Module.sol/StewardCowV2Module.json','utf8'));
const cowAbi=cowModule.abi.filter((item:{type:string;name?:string})=>item.type==='function'&&['openOrder','cancelOrder','reconcile','orderDigest','orderUid','pendingOrder','budgetStatus'].includes(item.name??'')||item.type==='event'&&['OrderOpened','OrderClosed'].includes(item.name??''));
const declarations=await Promise.all(names.map(async name=>{
  const file=JSON.parse(await readFile(`contracts/out/${name}.sol/${name}.json`,'utf8'));
  if(name==='StewardPasskeySignerV1')signerBytecode=file.bytecode.object;
  return `export const ${name}Abi = ${JSON.stringify(file.abi,null,2)} as const;`+(name==='StewardPasskeySignerV1'?`\nexport const StewardPasskeySignerV1CreationCode = ${JSON.stringify(file.bytecode.object)} as const;`:'');
}));
const outputs=[
  ['server/src/integrations/contracts.generated.ts','// Generated from Foundry artifacts by scripts/gen-abis.ts. Do not hand-edit.\n'+declarations.join('\n')],
  ['web/src/lib/passkeyArtifact.ts','// Generated from Foundry artifacts by scripts/gen-abis.ts. Do not hand-edit.\n'+`export const STEWARD_PASSKEY_SIGNER_CREATION_CODE = ${JSON.stringify(signerBytecode)} as \`0x\${string}\`;\n`],
  ['shared/src/v2ShellArtifact.generated.ts','// Generated from reviewed Foundry artifact. Immutable IDs 58811=v1Implementation, 58813=cowModule. Do not hand-edit.\n'+`export const V2_SHELL_RUNTIME_TEMPLATE = ${JSON.stringify(shell.deployedBytecode.object)} as \`0x\${string}\`;\nexport const V2_SHELL_V1_REFS = ${JSON.stringify(shellRefs['58811'])} as const;\nexport const V2_SHELL_MODULE_REFS = ${JSON.stringify(shellRefs['58813'])} as const;\n`],
  ['shared/src/v2OrderAbi.generated.ts','// Generated from reviewed Foundry artifact. Do not hand-edit.\n'+`export const V2_COW_ORDER_ABI = ${JSON.stringify(cowAbi,null,2)} as const;\n`],
];
for(const [path,output] of outputs){
  if(process.argv.includes('--check')){if(await readFile(path!,'utf8')!==output)throw new Error(`Contract artifact drift in ${path}: run bun scripts/gen-abis.ts after reviewing contract changes`);}
  else await writeFile(path!,output!);
}
