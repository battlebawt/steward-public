import { AddressSchema, ZERO_ADDRESS } from '@steward/shared';

export type DelegatePermission = 'payment' | 'buy' | 'sell';
const mask: Record<DelegatePermission, number> = { payment: 1, buy: 2, sell: 4 };

/** The contract's one raw-unit cap spans assets, so this simple flow uses reviewed account policy limits. */
export function buildDelegateRequest(input: { delegate: string; parent: string; permissions: readonly DelegatePermission[]; expiresInDays: 1 | 7 | 30; accountLimitsAcknowledged: boolean; nowSeconds: number }) {
  const delegate = AddressSchema.parse(input.delegate);
  if (delegate === ZERO_ADDRESS) throw Error('A caregiver wallet address is required.');
  if (delegate.toLowerCase() === AddressSchema.parse(input.parent).toLowerCase()) throw Error('The parent cannot be their own caregiver.');
  if (input.permissions.some((permission) => !(permission in mask))) throw Error('Unsupported caregiver action.');
  const actionMask = input.permissions.reduce((value, permission) => value | mask[permission], 0);
  if (!actionMask) throw Error('Choose at least one caregiver action.');
  if (!input.accountLimitsAcknowledged) throw Error('Confirm that the account policy limits will apply without an additional caregiver cap.');
  if (!Number.isSafeInteger(input.nowSeconds) || input.nowSeconds <= 0) throw Error('Current time is unavailable.');
  if (![1, 7, 30].includes(input.expiresInDays)) throw Error('Unsupported caregiver expiry.');
  return { operation: 'setDelegate' as const, delegate, actionMask: String(actionMask), expiresAt: String(input.nowSeconds + input.expiresInDays * 86_400), perActionLimit: '0' };
}

export function buildRevokeDelegateRequest(delegate: string) {
  const address = AddressSchema.parse(delegate);
  if (address === ZERO_ADDRESS) throw Error('A caregiver wallet address is required.');
  return { operation: 'revokeDelegate' as const, delegate: address };
}
