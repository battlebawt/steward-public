/** Read-only liquidity probe; a quote does not authorize or execute a trade. */
const symbol = 'AAPLx';
const network = 'BinanceSmartChain';
const quoteAmount = 100n * 10n ** 18n;
const quoteOwner = '0x000000000000000000000000000000000000dEaD';

async function json(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${body?.errorType ?? body?.message ?? 'request failed'}`);
  return body;
}

const asset = await json(`https://api.xstocks.fi/api/v2/public/assets/${symbol}`);
const deployment = asset.deployments?.find((item: any) => item.network === network);
const stablecoin = deployment?.stablecoins?.find((item: any) => item.symbol === 'USDC');
if (asset.symbol !== symbol || !deployment?.address || !stablecoin?.address || stablecoin.decimals !== 18) {
  throw new Error('Unexpected xStocks asset or BNB deployment metadata');
}

const quote = await json('https://api.cow.fi/bnb/api/v1/quote', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    sellToken: stablecoin.address,
    buyToken: deployment.address,
    from: quoteOwner,
    kind: 'sell',
    sellAmountBeforeFee: quoteAmount.toString(),
    priceQuality: 'optimal',
  }),
});
const q = quote.quote;
if (q?.sellToken?.toLowerCase() !== stablecoin.address.toLowerCase()
  || q?.buyToken?.toLowerCase() !== deployment.address.toLowerCase()
  || BigInt(q.sellAmount ?? 0) <= 0n
  || BigInt(q.buyAmount ?? 0) <= 0n
  || Number(q.validTo) <= Date.now() / 1000) {
  throw new Error('Quote fields or expiry do not match the requested pair');
}

console.log(JSON.stringify({
  observedAt: new Date().toISOString(),
  chainId: 56,
  provider: 'xStocks',
  symbol,
  asset: deployment.address,
  settlement: stablecoin.address,
  assetTradingHalted: asset.isTradingHalted,
  quoteVenue: 'CoW BNB order book',
  quoteSellAmountRaw: q.sellAmount,
  quoteBuyAmountRaw: q.buyAmount,
  quoteExpiresAt: new Date(Number(q.validTo) * 1000).toISOString(),
  limits: 'Read-only indicative quote; no account balance, order signature, fill, venue eligibility, or Steward guardrail execution verified.',
}, null, 2));
