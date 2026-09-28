import type { CatalogAsset } from './robinhood';

/** Pinned Base asset identity and 24/7 capability, not account eligibility or liquidity approval. */
export class BaseCryptoCatalog {
  constructor(private readonly chainId = 8453) {}

  async assets(): Promise<CatalogAsset[]> {
    if (this.chainId !== 8453) return [];
    const address = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf' as const;
    return [{
      id: `8453:${address.toLowerCase()}`, provider: 'coinbase', chainId: 8453,
      address, symbol: 'cbBTC', name: 'Coinbase Wrapped BTC', decimals: 8,
      multiplier: '1', sessions: { market: 'tradable', extended: 'tradable', overnight: 'tradable' },
      active: true, eligibility: 'review-required',
      termsUrl: 'https://www.coinbase.com/legal/user_agreement/united_states',
      raw: { source: 'pinned-base-cbbtc-identity', tradingVenue: 'independent-onchain-route' },
    }];
  }
}
