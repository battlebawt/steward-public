import type {Address} from 'viem';

/**
 * Durable account asset observations used by valuation. Implementations must
 * append observations and must not remove an address when policy changes.
 */
export interface ObservedAssetRegistry {
  remember(account: Address, assets: readonly Address[]): Promise<void> | void;
  list(account: Address): Promise<readonly Address[]> | readonly Address[];
}
