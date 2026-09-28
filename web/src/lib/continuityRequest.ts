import { AddressSchema, Bytes32Schema, UInt256Schema, ZERO_ADDRESS } from '@steward/shared';

export const CONTINUITY_OPERATIONS = [
  'startRecovery', 'approveRecovery', 'cancelRecovery', 'executeRecovery',
  'requestSuccession', 'approveSuccession', 'acceptSuccession', 'challengeSuccession', 'resolveSuccession', 'executeSuccession', 'cancelSuccession',
  'requestIncapacity', 'approveIncapacity', 'challengeIncapacity', 'resolveIncapacity', 'cancelIncapacity', 'expireIncapacity', 'executeIncapacity',
] as const;
export type ContinuityOperation = typeof CONTINUITY_OPERATIONS[number];

export function buildContinuityRequest(input: {
  operation: ContinuityOperation; id: string; successor: string; reviewer: string; planHash: string; evidenceHash: string;
  signature: string; approved: boolean; deadlineDays: 7 | 30; nowSeconds: number;
}): Record<string, unknown> {
  const { operation } = input;
  const id = () => UInt256Schema.parse(input.id.trim());
  const address = (value: string, name: string) => { const parsed = AddressSchema.parse(value.trim()); if (parsed === ZERO_ADDRESS) throw Error(`Enter a nonzero ${name} address.`); return parsed; };
  const hash = (value: string) => { const parsed = Bytes32Schema.parse(value.trim()); if (parsed === `0x${'0'.repeat(64)}`) throw Error('Enter a nonzero evidence or plan hash.'); return parsed; };
  const signature = () => { const value = input.signature.trim(); if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(value)) throw Error('Enter the required hex signature.'); return value; };
  const deadline = () => {
    if (!Number.isSafeInteger(input.nowSeconds) || input.nowSeconds <= 0 || ![7, 30].includes(input.deadlineDays)) throw Error('Choose a valid deadline.');
    return String(input.nowSeconds + input.deadlineDays * 86_400);
  };
  switch (operation) {
    case 'startRecovery': return { operation, successor: address(input.successor, 'successor') };
    case 'approveRecovery': case 'challengeSuccession': case 'challengeIncapacity': case 'cancelIncapacity': case 'expireIncapacity': case 'executeIncapacity': return { operation, id: id() };
    case 'cancelRecovery': case 'executeRecovery': case 'cancelSuccession': return { operation };
    case 'requestSuccession': {
      const successor = address(input.successor, 'successor'), reviewer = address(input.reviewer, 'reviewer');
      if (successor === reviewer) throw Error('The independent reviewer must differ from the successor.');
      return { operation, successor, reviewer, planHash: hash(input.planHash), evidenceHash: hash(input.evidenceHash), deadline: deadline() };
    }
    case 'approveSuccession': case 'acceptSuccession': case 'approveIncapacity': return { operation, id: id(), signature: signature() };
    case 'resolveSuccession': case 'resolveIncapacity': return { operation, id: id(), approved: input.approved };
    case 'executeSuccession': return { operation, id: id(), planHash: hash(input.planHash), evidenceHash: hash(input.evidenceHash) };
    case 'requestIncapacity': return { operation, evidenceHash: hash(input.evidenceHash), deadline: deadline() };
  }
}
