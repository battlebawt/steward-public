import {hashTypedData,type Address,type Hex} from 'viem'
import {z} from 'zod'
import {V2_COW_ORDER_ABI} from './v2OrderAbi.generated'

const address=z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(v=>v.toLowerCase() as Address)
const bytes32=z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(v=>v.toLowerCase() as Hex)
const uint=z.string().regex(/^(0|[1-9][0-9]*)$/).refine(v=>BigInt(v)<=(1n<<256n)-1n)
const uint32=uint.refine(v=>BigInt(v)<=(1n<<32n)-1n)
export const COW_KIND_SELL='0xf3b277728b3fee749481eb3e0b3b48980dbbab78658fc419025cb16eee346775' as Hex
export const COW_BALANCE_ERC20='0x5a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9' as Hex
export const CowOrderSchema=z.object({sellToken:address,buyToken:address,receiver:address,sellAmount:uint,buyAmount:uint,validTo:uint32,appData:bytes32,feeAmount:uint,kind:z.literal(COW_KIND_SELL),partiallyFillable:z.literal(false),sellTokenBalance:z.literal(COW_BALANCE_ERC20),buyTokenBalance:z.literal(COW_BALANCE_ERC20)}).strict()
export type CowOrderInput=z.input<typeof CowOrderSchema>
export type CowOrder=z.output<typeof CowOrderSchema>
export {V2_COW_ORDER_ABI}
export function contractCowOrder(input:CowOrderInput){const o=CowOrderSchema.parse(input);return {...o,sellAmount:BigInt(o.sellAmount),buyAmount:BigInt(o.buyAmount),validTo:Number(o.validTo),feeAmount:BigInt(o.feeAmount)}}
export function cowOrderDigest(input:CowOrderInput,chainId:number,settlement:Address):Hex{
 const o=contractCowOrder(input)
 if(!Number.isSafeInteger(chainId)||chainId<=0)throw Error('INVALID_COW_CHAIN')
 // GPv2's EIP-712 type names these three fields as strings. The contract
 // stores their prehashed bytes32 values in calldata to avoid dynamic strings.
 return hashTypedData({domain:{name:'Gnosis Protocol',version:'v2',chainId,verifyingContract:settlement},types:{Order:[{name:'sellToken',type:'address'},{name:'buyToken',type:'address'},{name:'receiver',type:'address'},{name:'sellAmount',type:'uint256'},{name:'buyAmount',type:'uint256'},{name:'validTo',type:'uint32'},{name:'appData',type:'bytes32'},{name:'feeAmount',type:'uint256'},{name:'kind',type:'string'},{name:'partiallyFillable',type:'bool'},{name:'sellTokenBalance',type:'string'},{name:'buyTokenBalance',type:'string'}]},primaryType:'Order',message:{...o,kind:'sell',sellTokenBalance:'erc20',buyTokenBalance:'erc20'}})
}
