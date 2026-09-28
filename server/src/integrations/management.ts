import { z } from 'zod';
import { AddressSchema,Bytes32Schema,UInt256Schema,UInt64Schema } from '@steward/shared';
const addresses=z.array(AddressSchema).max(32);
export const PolicyConfigSchema=z.object({
 settlement:AddressSchema,period:UInt64Schema,anchor:UInt64Schema,paymentLimit:UInt256Schema,buyLimit:UInt256Schema,reserve:UInt256Schema,
 perPayment:UInt256Schema,perBuy:UInt256Schema,perSell:UInt256Schema,exceptionQuorum:UInt256Schema,
 approvedTokens:addresses,paymentRecipients:addresses,exceptionSigners:addresses,guardians:addresses,
 approvedAdapters:addresses,sellCapTokens:addresses,sellCaps:z.array(UInt256Schema).max(32),
 continuityReviewer:AddressSchema,continuitySuccessor:AddressSchema,continuityPlanHash:Bytes32Schema
}).strict();
export function contractPolicy(input:unknown){
 const p=PolicyConfigSchema.parse(input);
 return {...p,period:BigInt(p.period),anchor:BigInt(p.anchor),paymentLimit:BigInt(p.paymentLimit),buyLimit:BigInt(p.buyLimit),reserve:BigInt(p.reserve),perPayment:BigInt(p.perPayment),perBuy:BigInt(p.perBuy),perSell:BigInt(p.perSell),exceptionQuorum:BigInt(p.exceptionQuorum),sellCaps:p.sellCaps.map(BigInt)};
}
export function managementCall(input:unknown):{method:string;args:unknown[]}{
 const p=z.object({operation:z.string(),policy:z.unknown().optional(),salt:Bytes32Schema.optional(),commitment:Bytes32Schema.optional(),delegate:AddressSchema.optional(),actionMask:UInt256Schema.optional(),expiresAt:UInt64Schema.optional(),perActionLimit:UInt256Schema.optional(),adapter:AddressSchema.optional(),module:AddressSchema.optional(),caregiver:AddressSchema.optional(),token:AddressSchema.optional(),amount:UInt256Schema.optional(),recipient:AddressSchema.optional(),enabled:z.boolean().optional()}).strict().parse(input);
 const required=<T>(v:T|undefined):T=>{if(v===undefined)throw new Error('INVALID_MANAGEMENT_INPUT');return v;};
 switch(p.operation){
 case 'tightenPolicy': return {method:p.operation,args:[contractPolicy(p.policy)]};
 case 'queuePolicyExpansion': return {method:p.operation,args:[required(p.commitment)]};
 case 'executePolicyExpansion': return {method:p.operation,args:[contractPolicy(p.policy),required(p.salt)]};
 case 'cancelPolicyExpansion': case 'executeAdapterAdmission': case 'executeIncapacityModule': case 'deactivateIncapacity': case 'pauseDelegatedSpending': case 'unpauseDelegatedSpending': return {method:p.operation,args:[]};
 case 'setDelegate': return {method:p.operation,args:[required(p.delegate),BigInt(required(p.actionMask)),BigInt(required(p.expiresAt)),BigInt(required(p.perActionLimit))]};
 case 'revokeDelegate': return {method:p.operation,args:[required(p.delegate)]};
 case 'queueIncapacityModule': return {method:p.operation,args:[required(p.module),required(p.caregiver),BigInt(required(p.actionMask)),BigInt(required(p.perActionLimit))]};
 case 'withdraw': return {method:p.operation,args:[required(p.token),BigInt(required(p.amount)),required(p.recipient)]};
 case 'admitAdapter': return {method:p.operation,args:[required(p.adapter),required(p.enabled)]};
 default:throw new Error('UNSUPPORTED_MANAGEMENT_OPERATION');
 }
}
