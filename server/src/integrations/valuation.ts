import {z} from 'zod';
import {AddressSchema,Bytes32Schema} from '@steward/shared';
/** Prices are reviewed per-token USD feeds, never raw underlying-equity quotes. */
export const EIP1967_IMPLEMENTATION_SLOT=`0x${'360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'}` as const;
const sourceShape=z.object({asset:AddressSchema,source:AddressSchema,sourceCodeHash:Bytes32Schema,maxAgeSeconds:z.number().int().positive().max(86400*7),quoteCurrency:z.literal('USD'),priceBasis:z.literal('per-token'),sourceKind:z.enum(['immutable','eip1967']),implementation:AddressSchema.optional(),implementationCodeHash:Bytes32Schema.optional(),implementationSlot:Bytes32Schema.optional()}).strict();
export const ValuationSourceSchema=sourceShape.superRefine((value,ctx)=>{
 if(value.sourceKind==='immutable'&&(value.implementation||value.implementationCodeHash||value.implementationSlot))ctx.addIssue({code:'custom',message:'Immutable valuation sources cannot carry proxy pins'});
 if(value.sourceKind==='eip1967'&&(!value.implementation||!value.implementationCodeHash))ctx.addIssue({code:'custom',message:'EIP-1967 valuation sources require implementation pins'});
});
export type ValuationSource=z.infer<typeof ValuationSourceSchema>;
export type ValuationHolding={address:`0x${string}`;balanceRaw:string;decimals:number;observedBlock:string;observedBlockHash:`0x${string}`;finality:'latest';source:`0x${string}`|null;sourceCodeHash:`0x${string}`|null;sourceKind:'immutable'|'eip1967'|null;implementation:`0x${string}`|null;implementationCodeHash:`0x${string}`|null;implementationSlot:`0x${string}`|null;priceBasis:'per-token'|null;maxAgeSeconds:number|null;priceRaw:string|null;priceDecimals:number|null;valueRaw:string|null;priceUpdatedAt:string|null;status:'priced'|'unavailable';reason?:string};
export type PortfolioValuation={scope:'policy-and-observed-assets';currency:'USD';decimals:8;observedBlock:string;observedBlockHash:`0x${string}`;finality:'latest';observedAt:string;status:'complete'|'partial'|'unavailable';totalValueRaw:string|null;pricedSubtotalRaw:string;holdings:ValuationHolding[]};
export function valueInUsd(balance:bigint,tokenDecimals:number,price:bigint,priceDecimals:number){
 if(balance<0n||price<=0n||!Number.isInteger(tokenDecimals)||tokenDecimals<0||tokenDecimals>36||!Number.isInteger(priceDecimals)||priceDecimals<0||priceDecimals>36)throw Error('INVALID_VALUATION_INPUT');
 // Single exact rational calculation, rounded down once; never floating point or a second multiplier.
 return balance*price*100_000_000n/(10n**BigInt(tokenDecimals+priceDecimals));
}
