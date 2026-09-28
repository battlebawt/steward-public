import { z } from 'zod';
import { AddressSchema, Bytes32Schema, UInt256Schema, UInt64Schema } from '@steward/shared';
const signature = z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/).max(65538);
/** Only reviewed ABI entry points; never caller-supplied target/calldata. */
export function continuityCall(input: unknown): { target: 'account' | 'incapacity'; method: string; args: unknown[] } {
  const p = z.object({ operation: z.string(), id: UInt256Schema.optional(), successor: AddressSchema.optional(), reviewer: AddressSchema.optional(), planHash: Bytes32Schema.optional(), evidenceHash: Bytes32Schema.optional(), deadline: UInt64Schema.optional(), signature: signature.optional(), approved: z.boolean().optional() }).strict().parse(input);
  const required = <T>(v: T | undefined): T => { if (v === undefined) throw new Error('INVALID_CONTINUITY_INPUT'); return v; };
  const id = () => BigInt(required(p.id));
  switch (p.operation) {
    case 'startRecovery': return { target: 'account', method: p.operation, args: [required(p.successor)] };
    case 'approveRecovery': return { target: 'account', method: p.operation, args: [id()] };
    case 'cancelRecovery': case 'executeRecovery': case 'cancelSuccession': return { target: 'account', method: p.operation, args: [] };
    case 'requestSuccession': return { target: 'account', method: p.operation, args: [required(p.successor), required(p.reviewer), required(p.planHash), required(p.evidenceHash), BigInt(required(p.deadline))] };
    case 'approveSuccession': case 'acceptSuccession': return { target: 'account', method: p.operation, args: [id(), required(p.signature)] };
    case 'challengeSuccession': return { target: 'account', method: p.operation, args: [id()] };
    case 'resolveSuccession': return { target: 'account', method: p.operation, args: [id(), required(p.approved)] };
    case 'executeSuccession': return { target: 'account', method: p.operation, args: [id(), required(p.planHash), required(p.evidenceHash)] };
    case 'requestIncapacity': return { target: 'incapacity', method: 'request', args: [required(p.evidenceHash), BigInt(required(p.deadline))] };
    case 'approveIncapacity': return { target: 'incapacity', method: 'approve', args: [id(), required(p.signature)] };
    case 'resolveIncapacity': return { target: 'incapacity', method: 'resolve', args: [id(), required(p.approved)] };
    case 'challengeIncapacity': case 'cancelIncapacity': case 'expireIncapacity': case 'executeIncapacity': return { target: 'incapacity', method: p.operation.replace('Incapacity', ''), args: [id()] };
    default: throw new Error('UNSUPPORTED_CONTINUITY_OPERATION');
  }
}
