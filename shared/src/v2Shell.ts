import {keccak256,padHex,type Address,type Hex} from 'viem'
import {V2_SHELL_RUNTIME_TEMPLATE,V2_SHELL_V1_REFS,V2_SHELL_MODULE_REFS} from './v2ShellArtifact.generated'

/** Reconstruct the exact reviewed shell runtime before the factory's first account. */
export function expectedV2ShellRuntimeCode(v1:Address,module:Address):Hex {
  let code:string=V2_SHELL_RUNTIME_TEMPLATE
  for(const [address,refs] of [[v1,V2_SHELL_V1_REFS],[module,V2_SHELL_MODULE_REFS]] as const){
    const word=padHex(address,{size:32}).slice(2)
    for(const {start,length} of refs){
      if(length!==32||start<0||2+(start+length)*2>code.length)throw Error('V2_SHELL_ARTIFACT_INVALID')
      code=code.slice(0,2+start*2)+word+code.slice(2+(start+length)*2)
    }
  }
  return code as Hex
}
export function expectedV2ShellRuntimeCodeHash(v1:Address,module:Address):Hex {
  return keccak256(expectedV2ShellRuntimeCode(v1,module))
}
