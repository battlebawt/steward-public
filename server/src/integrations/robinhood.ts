/** Read-only provider integration. Source: https://docs.robinhood.com/chain/stock-token-apis/ */
import { isAddress } from 'viem';
export type Tradability = 'tradable' | 'closing_only' | 'opening_only' | 'blocked' | 'unknown';
export type Sessions = Record<'market' | 'extended' | 'overnight', Tradability>;
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
function status(v: unknown): Tradability {
  if (v === 'tradable' || v === 'TRADING_STATUS_TRADABLE') return 'tradable';
  if (v === 'position_closing_only' || v === 'TRADING_STATUS_POSITION_CLOSING_ONLY') return 'closing_only';
  if (v === 'position_opening_only' || v === 'TRADING_STATUS_POSITION_OPENING_ONLY') return 'opening_only';
  if (v === 'untradable' || v === 'TRADING_STATUS_UNTRADABLE') return 'blocked';
  return 'unknown';
}
export function normalizeSessions(value: unknown): Sessions {
  const v = record(value);
  if ('market' in v || 'extended' in v || 'overnight' in v) {
    return { market: status(record(v.market).fractional), extended: status(record(v.extended).fractional), overnight: status(record(v.overnight).fractional) };
  }
  const market = status(v.fractionalTradability);
  return { market, extended: v.extendedHoursFractionalTradability === false ? 'blocked' : v.extendedHoursFractionalTradability === true ? market : 'unknown', overnight: status(v.allDayTradability) };
}
export function sessionAllows(s: Tradability, side: 'BUY' | 'SELL'): boolean {
  return s === 'tradable' || s === (side === 'BUY' ? 'opening_only' : 'closing_only');
}
export type CatalogAsset = {
  id: string; provider: string; chainId: number; address: `0x${string}`; symbol: string; name: string;
  decimals: number | null; multiplier: string; sessions: Sessions; active: boolean;
  eligibility: 'review-required'; termsUrl: string; raw: Record<string, unknown>;
};
export function normalizeCatalog(payload: unknown, chainId: number): CatalogAsset[] {
  const envelope = record(payload);
  const rows = Array.isArray(payload) ? payload : envelope.assets;
  if (!Array.isArray(rows) || rows.length > 10000) throw new Error('PROVIDER_SCHEMA_INVALID');
  const seen = new Set<string>();
  return rows.flatMap(value => {
    const row = record(value);
    if (typeof row.tokenSymbol !== 'string' || row.tokenSymbol.length > 32 || typeof row.tokenName !== 'string' || row.tokenName.length > 256) return [];
    if (typeof row.currentMultiplier !== 'string' || !/^(0|[1-9]\d{0,30})(\.\d{1,18})?$/.test(row.currentMultiplier) || !/[1-9]/.test(row.currentMultiplier)) return [];
    const deployments = Array.isArray(row.deployments) ? row.deployments : [];
    const deployment = deployments.map(record).find(d => d.chainId === chainId && typeof d.contractAddress === 'string' && isAddress(d.contractAddress));
    if (!deployment) return [];
    const address = String(deployment.contractAddress).toLowerCase() as `0x${string}`;
    const id = `${chainId}:${address}`;
    if (seen.has(id)) throw new Error('PROVIDER_DUPLICATE_ASSET');
    seen.add(id);
    return [{ id, provider: 'robinhood' as const, chainId, address, symbol: row.tokenSymbol, name: row.tokenName,
      decimals: Number.isInteger(row.tokenDecimals) && Number(row.tokenDecimals) >= 0 && Number(row.tokenDecimals) <= 36 ? Number(row.tokenDecimals) : null,
      multiplier: row.currentMultiplier, sessions: normalizeSessions(row.tradingCapabilities), active: row.status === 'ASSET_STATUS_ACTIVE',
      eligibility: 'review-required' as const, termsUrl: 'https://robinhood.com/rhj/stocktokens/', raw: row }];
  });
}
export class RobinhoodCatalog {
  private cached?: { at: number; assets: CatalogAsset[] };
  private pending?: Promise<CatalogAsset[]>;
  constructor(private readonly chainId = 4663, private readonly fetcher: typeof fetch = fetch, private readonly now = Date.now) {}
  async assets(): Promise<CatalogAsset[]> {
    if (this.cached && this.now() - this.cached.at < 60_000) return this.cached.assets;
    if (this.pending) return this.pending;
    this.pending = this.load();
    try { return await this.pending; } finally { this.pending = undefined; }
  }
  private async load(): Promise<CatalogAsset[]> {
    try {
      const response = await this.fetcher('https://api.robinhood.com/rhj/assets', { signal: AbortSignal.timeout(8000), redirect: 'error' });
      if (!response.ok) throw new Error('PROVIDER_UNAVAILABLE');
      const text = await response.text();
      if (text.length > 5_000_000) throw new Error('PROVIDER_SCHEMA_INVALID');
      const assets = normalizeCatalog(JSON.parse(text), this.chainId);
      this.cached = { at: this.now(), assets };
      return assets;
    } catch { throw new Error('ASSET_CATALOG_UNAVAILABLE'); }
  }
}
