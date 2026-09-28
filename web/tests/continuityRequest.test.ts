import { expect, test } from 'bun:test';
import { buildContinuityRequest, CONTINUITY_OPERATIONS, type ContinuityOperation } from '../src/lib/continuityRequest';
import { encodeContinuityCall, verifyContinuityCalldata } from '../src/lib/management';

const base = { operation: 'requestSuccession' as ContinuityOperation, id: '7', successor: `0x${'1'.repeat(40)}`, reviewer: `0x${'2'.repeat(40)}`, planHash: `0x${'3'.repeat(64)}`, evidenceHash: `0x${'4'.repeat(64)}`, signature: `0x${'5'.repeat(130)}`, approved: true, deadlineDays: 7 as const, nowSeconds: 1_000_000 };

test('all named continuity operations encode as existing reviewed contract calls', () => {
  for (const operation of CONTINUITY_OPERATIONS) {
    const request = buildContinuityRequest({ ...base, operation });
    const encoded = encodeContinuityCall(request);
    expect(verifyContinuityCalldata(request, encoded).ok).toBe(true);
  }
});

test('guided continuity rejects missing evidence, invalid deadlines and absent approvals', () => {
  expect(() => buildContinuityRequest({ ...base, planHash: `0x${'0'.repeat(64)}` })).toThrow('nonzero');
  expect(() => buildContinuityRequest({ ...base, deadlineDays: 1 as 7 })).toThrow('deadline');
  expect(() => buildContinuityRequest({ ...base, operation: 'approveSuccession', signature: '0x' })).toThrow('signature');
  expect(() => buildContinuityRequest({ ...base, reviewer: base.successor })).toThrow('differ');
});
