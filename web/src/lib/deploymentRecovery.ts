import { AddressSchema, Bytes32Schema } from '@steward/shared';

export type PendingDeployment = { chainId: number; parent: `0x${string}`; factory: `0x${string}`; hash: `0x${string}` };

export function pendingDeploymentKey(chainId: number, parent: string) {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw Error('Invalid deployment network.');
  return `steward.pending-deployment.${chainId}.${AddressSchema.parse(parent)}`;
}

/** Local storage is a recovery hint, never proof that the factory transaction succeeded. */
export function parsePendingDeployment(raw: string | null, chainId: number, parent: string, factory: string): PendingDeployment | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (Object.keys(value).sort().join(',') !== 'chainId,factory,hash,parent') return undefined;
    if (value.chainId !== chainId || AddressSchema.parse(value.parent) !== AddressSchema.parse(parent) || AddressSchema.parse(value.factory) !== AddressSchema.parse(factory)) return undefined;
    return { chainId, parent: AddressSchema.parse(parent), factory: AddressSchema.parse(factory), hash: Bytes32Schema.parse(value.hash) };
  } catch { return undefined; }
}
