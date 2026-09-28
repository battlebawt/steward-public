/** Read-only RPC pool; configured URLs are never included in outward errors. */
export class RpcUnavailable extends Error { constructor(public readonly code: 'RPC_UNAVAILABLE' | 'RPC_DISAGREEMENT') { super(code); } }
type RpcBlock = { number: `0x${string}`; hash: `0x${string}`; parentHash: `0x${string}`; timestamp: `0x${string}` };
const allowed = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getLogs', 'eth_getCode', 'eth_getStorageAt', 'eth_call', 'eth_getBalance', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getTransactionCount', 'eth_estimateGas', 'eth_gasPrice']);
export class ReadRpcPool {
  private selected?: { url: string; validatedAt: number };
  constructor(private readonly urls: string[], readonly chainId: number, private readonly fetcher: typeof fetch = fetch, private readonly now = Date.now, private readonly maxAgeSeconds = 120) {
    if (!urls.length || urls.length > 3 || urls.some(u => { try { return !['https:', 'http:'].includes(new URL(u).protocol); } catch { return true; } })) throw new Error('INVALID_RPC_CONFIG');
  }
  private async callAt<T>(url: string, method: string, params: unknown[]): Promise<T> {
    try {
      const response = await this.fetcher(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(8000), redirect: 'error' });
      if (!response.ok) throw new Error();
      const value = await response.json() as { id?: number; error?: unknown; result?: T };
      if (value.id !== 1 || value.error || !('result' in value)) throw new Error();
      return value.result as T;
    } catch { throw new RpcUnavailable('RPC_UNAVAILABLE'); }
  }
  private async validate(url: string): Promise<{ url: string; block: RpcBlock }> {
    const [chain, block] = await Promise.all([this.callAt<string>(url, 'eth_chainId', []), this.callAt<RpcBlock>(url, 'eth_getBlockByNumber', ['latest', false])]);
    const time = Number(BigInt(block.timestamp));
    if (BigInt(chain) !== BigInt(this.chainId) || !/^0x[\da-f]{64}$/i.test(block.hash) || this.now() / 1000 - time > this.maxAgeSeconds || time > this.now() / 1000 + 30) throw new RpcUnavailable('RPC_UNAVAILABLE');
    return { url, block };
  }
  async request<T>(method: string, params: unknown[] = []): Promise<T> {
    if (!allowed.has(method)) throw new Error('RPC_METHOD_NOT_ALLOWED');
    if (this.selected && this.now() - this.selected.validatedAt < 2000) {
      try { return await this.callAt<T>(this.selected.url, method, params); }
      catch (error) { this.selected = undefined; throw error; }
    }
    const settled = await Promise.allSettled(this.urls.map(url => this.validate(url)));
    const healthy = settled.flatMap(r => r.status === 'fulfilled' ? [r.value] : []);
    if (!healthy.length) throw new RpcUnavailable('RPC_UNAVAILABLE');
    // Compare canonical hashes at the same height; differing latest heights alone are ordinary lag.
    if (healthy.length > 1) {
      const minimum = healthy.reduce((n, p) => BigInt(p.block.number) < n ? BigInt(p.block.number) : n, BigInt(healthy[0]!.block.number));
      const blocks = await Promise.all(healthy.map(p => this.callAt<RpcBlock>(p.url, 'eth_getBlockByNumber', [`0x${minimum.toString(16)}`, false])));
      if (blocks.some(b => !b || b.hash.toLowerCase() !== blocks[0]!.hash.toLowerCase())) throw new RpcUnavailable('RPC_DISAGREEMENT');
    }
    // Never retry a semantic eth_call failure against another provider to find a favorable answer.
    this.selected = { url: healthy[0]!.url, validatedAt: this.now() };
    return this.callAt<T>(healthy[0]!.url, method, params);
  }
}
