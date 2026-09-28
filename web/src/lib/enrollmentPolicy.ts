import { AddressSchema, UInt256Schema, ZERO_ADDRESS, type AssetDescriptor } from '@steward/shared';
import { parseAmount, parsePositiveAmount } from './amounts';

const ZERO_HASH = `0x${'0'.repeat(64)}`;
const DAY = '86400';

function address(value: string, field: string, parent: string, allowParent = false) {
  const parsed = AddressSchema.parse(value.trim());
  if (parsed === ZERO_ADDRESS || (!allowParent && parsed === parent)) throw Error(`${field} must be a different, nonzero wallet address.`);
  return parsed;
}

function addressList(value: string, field: string, parent: string, minimum: number, allowParent = false) {
  const entries = value.split(/[\s,]+/).filter(Boolean).map((entry) => address(entry, field, parent, allowParent));
  if (entries.length < minimum || entries.length > 32 || new Set(entries).size !== entries.length) throw Error(`${field} needs ${minimum} or more distinct wallet addresses (maximum 32).`);
  return entries;
}

/** A starter policy: ordinary payments work; stock venues remain unadmitted until separately reviewed. */
export function buildEnrollmentPolicy(input: {
  asset: AssetDescriptor; chainId: number; parent: string;
  paymentLimit: string; perPayment: string; buyLimit: string; perBuy: string; reserve: string;
  paymentRecipients: string; exceptionSigners: string; guardians: string;
  continuityReviewer: string; continuitySuccessor: string;
}) {
  const parent = AddressSchema.parse(input.parent);
  const asset = input.asset;
  if (asset.chainId !== input.chainId || asset.legalInstrumentType !== 'settlement_token' || !asset.capabilities.includes('payment') || asset.admission !== 'allowed') throw Error('Choose an available settlement token on the connected network.');
  const paymentLimit = UInt256Schema.parse(parsePositiveAmount(input.paymentLimit, asset.decimals));
  const perPayment = UInt256Schema.parse(parsePositiveAmount(input.perPayment, asset.decimals));
  const buyLimit = UInt256Schema.parse(parseAmount(input.buyLimit, asset.decimals));
  const perBuy = UInt256Schema.parse(parseAmount(input.perBuy, asset.decimals));
  const reserve = UInt256Schema.parse(parseAmount(input.reserve, asset.decimals));
  if (BigInt(perPayment) > BigInt(paymentLimit)) throw Error('Each payment limit must fit within the daily payment limit.');
  if (BigInt(perBuy) > BigInt(buyLimit) || (BigInt(buyLimit) > 0n && BigInt(perBuy) === 0n)) throw Error('Each buy limit must be positive and fit within the daily buy limit.');
  const reviewer = address(input.continuityReviewer, 'Continuity reviewer', parent);
  const successor = address(input.continuitySuccessor, 'Successor', parent);
  if (reviewer === successor) throw Error('The continuity reviewer must be different from the successor.');
  return {
    settlement: asset.address, period: DAY, anchor: '0', paymentLimit, buyLimit, reserve, perPayment, perBuy,
    perSell: '0', exceptionQuorum: '2', approvedTokens: [] as `0x${string}`[],
    paymentRecipients: addressList(input.paymentRecipients, 'Payment recipients', parent, 1, true),
    exceptionSigners: addressList(input.exceptionSigners, 'Co-signers', parent, 2),
    guardians: addressList(input.guardians, 'Guardians', parent, 3),
    approvedAdapters: [] as `0x${string}`[], sellCapTokens: [] as `0x${string}`[], sellCaps: [] as string[],
    continuityReviewer: reviewer,
    continuitySuccessor: successor,
    continuityPlanHash: ZERO_HASH,
  };
}
