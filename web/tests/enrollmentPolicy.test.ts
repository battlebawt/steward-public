import { expect, test } from 'bun:test';
import type { AssetDescriptor } from '@steward/shared';
import { buildEnrollmentPolicy } from '../src/lib/enrollmentPolicy';

const addr = (digit: string): `0x${string}` => `0x${digit.repeat(40)}`;
const parent = addr('1');
const asset = { id: 'mock', provider: 'fixture', chainId: 31337, address: addr('9'), symbol: 'USDG', name: 'Test settlement', decimals: 6, legalInstrumentType: 'settlement_token', sourceTermsVersion: 'fixture', capabilities: ['payment'], admission: 'allowed' } as AssetDescriptor;
const input = { asset, chainId: 31337, parent, paymentLimit: '500', perPayment: '50.25', buyLimit: '100', perBuy: '25', reserve: '100', paymentRecipients: parent, exceptionSigners: `${addr('2')}\n${addr('3')}`, guardians: `${addr('4')}\n${addr('5')}\n${addr('6')}`, continuityReviewer: addr('7'), continuitySuccessor: addr('8') };

test('guided enrollment builds a decimal-exact, market-independent account policy', () => {
  const policy = buildEnrollmentPolicy(input);
  expect(policy.paymentLimit).toBe('500000000');
  expect(policy.perPayment).toBe('50250000');
  expect(policy.buyLimit).toBe('100000000');
  expect(policy.approvedTokens).toEqual([]);
  expect(policy.approvedAdapters).toEqual([]);
  expect(policy.guardians).toHaveLength(3);
  expect(policy.continuitySuccessor).toBe(input.continuitySuccessor);
});

test('guided enrollment rejects unknown units and inadequate family controls', () => {
  expect(() => buildEnrollmentPolicy({ ...input, chainId: 46630 })).toThrow('settlement token');
  expect(() => buildEnrollmentPolicy({ ...input, perPayment: '0.0000001' })).toThrow('decimal places');
  expect(() => buildEnrollmentPolicy({ ...input, guardians: `${addr('4')} ${addr('4')} ${addr('6')}` })).toThrow('distinct');
  expect(() => buildEnrollmentPolicy({ ...input, continuityReviewer: parent })).toThrow('different');
  expect(() => buildEnrollmentPolicy({ ...input, continuityReviewer: input.continuitySuccessor })).toThrow('different');
});
