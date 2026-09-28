/**
 * Robinhood Chain provider evidence harness.
 *
 * This command is deliberately read-only. It does not read private keys or
 * environment variables, sign, send, impersonate, or mutate a public chain.
 * It snapshots public RPC/API state and the source/config hashes needed to
 * reproduce a provider admission review.
 *
 *   bun scripts/provider-fork.ts
 *   bun scripts/provider-fork.ts --output docs/evidence/provider-launch-results.json
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { ContractFunctionRevertedError, createPublicClient, createWalletClient, encodeDeployData, http, keccak256, parseAbi, type Address } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';

const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const CHAIN_ID = 4663;
const AAPL = '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9' as Address;
// AAPL exposes this implementation pointer in its runtime bytecode rather
// than an EIP-1967 implementation slot.
const AAPL_IMPLEMENTATION = '0xe10b6F6b275de231345c20D14ab812Db62151b00' as Address;
const AAPL_FEED = '0x6B22A786bAa607d76728168703a39Ea9C99f2cD0' as Address;
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address;
const USDG_IMPLEMENTATION = '0x68184c449e1A8f34fA18d289737129Fd27b66F8f' as Address;
const USDG_FEED = '0x61B7e5650328764B076A108EFF5fa7282a1B9aD2' as Address;
const V3_ROUTER = '0xCaf681a66D020601342297493863E78C959E5cb2' as Address;
const V3_QUOTER = '0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7' as Address;

const erc20Abi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
]);
const tokenAbi = parseAbi([
  'function uiMultiplier() view returns (uint256)',
  'function newUIMultiplier() view returns (uint256)',
  'function effectiveAt() view returns (uint256)',
  'function oraclePaused() view returns (bool)',
]);
const feedAbi = parseAbi([
  'function decimals() view returns (uint8)',
  'function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)',
]);
const quoterAbi = parseAbi([
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) view returns (uint256,uint160,uint32,uint256)',
]);

type Check = { ok: boolean; value?: unknown; error?: string };
type Snapshot = {
  observedAtUtc: string;
  mode: 'public-read-only' | 'public-read-only+local-fork-negative';
  rpc: string;
  chainId: number;
  block: { number: string; hash: string; timestamp: string };
  source: { gitHead?: string; sha256: Record<string, string> };
  addresses: Record<string, string>;
  code: Record<string, { bytes: number; keccak256?: string }>;
  token: Record<string, unknown>;
  feeds: Record<string, unknown>;
  catalog: unknown;
  prices: unknown;
  venue: Record<string, unknown>;
  sequencer: Record<string, unknown>;
  accountFork: { status: 'blocked'; reason: string; manifestAccounts: number; publicTransactions: false };
  localNegativeCheck?: { status: 'passed' | 'not-run' | 'failed'; detail: string; chainId?: number; forkBlock?: string };
  checks: Record<string, Check>;
};

const sha256 = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');
const shortError = (e: unknown) => String(e).replace(/\s+/g, ' ').slice(0, 300);
const hasEvmRevert = (error: unknown) => {
  let current: any = error;
  for (let depth = 0; current && depth < 16; depth++, current = current.cause) {
    if (current instanceof ContractFunctionRevertedError) return true;
  }
  return false;
};
const check = async (checks: Record<string, Check>, name: string, fn: () => Promise<unknown>) => {
  try {
    const value = await fn();
    checks[name] = { ok: true, value };
    return value;
  } catch (e) {
    checks[name] = { ok: false, error: shortError(e) };
    return undefined;
  }
};
const hexAddress = (value: string) => `0x${value.slice(-40)}`;
const asRound = (round: readonly [bigint, bigint, bigint, bigint, bigint]) => ({
  roundId: round[0].toString(),
  answer: round[1].toString(),
  startedAt: round[2].toString(),
  updatedAt: round[3].toString(),
  answeredInRound: round[4].toString(),
});

async function getJson(url: string) {
  const response = await fetch(url, { headers: { 'user-agent': 'Steward-provider-fork/1 (read-only evidence)' } });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

async function localSequencerConstructorNegativeCheck(forkBlock: bigint) {
  const sourceArtifactPath = 'contracts/out/StewardChainlinkPriceSourceV1.sol/StewardChainlinkPriceSourceV1.json';
  const adapterArtifactPath = 'contracts/out/StewardTradeAdapterV1.sol/StewardTradeAdapterV1.json';
  if (!existsSync(sourceArtifactPath) || !existsSync(adapterArtifactPath)) return { status: 'not-run' as const, detail: `missing artifacts ${sourceArtifactPath} or ${adapterArtifactPath}` };
  const port = 18545;
  const mnemonic = 'test test test test test test test test test test test junk';
  const processHandle = Bun.spawn(['anvil', '--fork-url', RPC, '--fork-block-number', forkBlock.toString(), '--port', String(port), '--mnemonic', mnemonic, '--silent'], { stdout: 'ignore', stderr: 'pipe' });
  try {
    const localRpc = `http://127.0.0.1:${port}`;
    const local = createPublicClient({ transport: http(localRpc) });
    for (let i = 0; i < 50; i++) {
      try { if (await local.getChainId() === CHAIN_ID) break; } catch { /* wait for Anvil */ }
      await Bun.sleep(100);
    }
    if (await local.getChainId() !== CHAIN_ID) return { status: 'failed' as const, detail: 'local Anvil did not expose chain 4663' };
    const sourceArtifact = JSON.parse(await readFile(sourceArtifactPath, 'utf8'));
    const adapterArtifact = JSON.parse(await readFile(adapterArtifactPath, 'utf8'));
    const account = mnemonicToAccount(mnemonic);
    const wallet = createWalletClient({ account, transport: http(localRpc) });
    const sendTransaction: any = wallet.sendTransaction.bind(wallet);
    const deploy = async (artifact: any, args: readonly unknown[]) => {
      const bytecode = artifact.bytecode.object.startsWith('0x') ? artifact.bytecode.object : `0x${artifact.bytecode.object}`;
      const data = encodeDeployData({ abi: artifact.abi, bytecode, args } as any);
      // Supplying gas bypasses estimation only to observe the actual local
      // fork result. This is never a public send.
      const hash = await sendTransaction({ account, data, gas: 3_000_000n });
      const receipt = await local.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`local deployment reverted: ${hash}`);
      return receipt.contractAddress;
    };
    // Nonzero but empty sequencer address models an unconfigured/unverified
    // uptime source. The source can be deployed, but the real adapter's quote
    // path must refuse to use it when latestRoundData cannot be read.
    const source = await deploy(sourceArtifact, [account.address, '0x0000000000000000000000000000000000000001', 3600n, [USDG, AAPL], [USDG_FEED, AAPL_FEED], [86400n, 86400n]]);
    const adapter = await deploy(adapterArtifact, [USDG, '0x0000000000000000000000000000000000000002', source, 86400n, 500n, [AAPL], [AAPL_FEED]]);
    try {
      await (local.readContract as any)({ address: source, abi: sourceArtifact.abi, functionName: 'price', args: [AAPL] });
      return { status: 'failed' as const, detail: 'actual StewardChainlinkPriceSourceV1 price unexpectedly succeeded with empty sequencer feed', chainId: CHAIN_ID, forkBlock: forkBlock.toString() };
    } catch (error) {
      if (!hasEvmRevert(error)) return { status: 'failed' as const, detail: `source price call failed without a ContractFunctionRevertedError: ${shortError(error)}`, chainId: CHAIN_ID, forkBlock: forkBlock.toString() };
    }
    try {
      await (local.readContract as any)({ address: adapter, abi: adapterArtifact.abi, functionName: 'quote', args: [USDG, AAPL, 100n * 1_000_000n] });
      return { status: 'failed' as const, detail: 'actual adapter quote unexpectedly succeeded with empty sequencer feed', chainId: CHAIN_ID, forkBlock: forkBlock.toString() };
    } catch (error) {
      if (!hasEvmRevert(error)) return { status: 'failed' as const, detail: `adapter quote failed without a ContractFunctionRevertedError: ${shortError(error)}`, chainId: CHAIN_ID, forkBlock: forkBlock.toString() };
      return { status: 'passed' as const, detail: 'actual source.price(AAPL) and StewardTradeAdapterV1 quote reverted with ContractFunctionRevertedError when the configured sequencer feed had no readable latestRoundData; no happy-path price or swap was asserted.', chainId: CHAIN_ID, forkBlock: forkBlock.toString() };
    }
  } catch (e) {
    return { status: 'failed' as const, detail: shortError(e), chainId: CHAIN_ID, forkBlock: forkBlock.toString() };
  } finally {
    processHandle.kill();
  }
}

async function main() {
  const argOutput = process.argv.find((v) => v.startsWith('--output='))?.slice('--output='.length);
  const runLocalNegative = process.argv.includes('--local-negative');
  const output = argOutput ?? 'docs/evidence/provider-launch-results.json';
  const client = createPublicClient({ transport: http(RPC) });
  // viem's installed type surface currently requires an experimental
  // authorizationList field even for view calls; this harness only performs
  // eth_call, so keep the runtime call explicit and side-effect free.
  const readContract: any = client.readContract.bind(client);
  const checks: Record<string, Check> = {};
  const chainId = Number(await client.getChainId());
  if (chainId !== CHAIN_ID) throw new Error(`unexpected chain id ${chainId}`);
  const block = await client.getBlock({ blockTag: 'latest' });
  const blockResult = { number: block.number.toString(), hash: block.hash, timestamp: block.timestamp.toString() };

  const addresses = { chain: String(CHAIN_ID), aapl: AAPL, aaplImplementation: AAPL_IMPLEMENTATION, aaplFeed: AAPL_FEED, usdg: USDG, usdgImplementation: USDG_IMPLEMENTATION, usdgFeed: USDG_FEED, v3Router: V3_ROUTER, v3Quoter: V3_QUOTER };
  const code: Snapshot['code'] = {};
  for (const [name, address] of Object.entries(addresses).filter(([name]) => name !== 'chain')) {
    const bytes = await client.getCode({ address: address as Address, blockNumber: block.number });
    code[name] = { bytes: bytes ? (bytes.length - 2) / 2 : 0, keccak256: bytes && bytes !== '0x' ? keccak256(bytes) : undefined };
  }

  const token: Record<string, unknown> = {};
  for (const [label, address] of [['aapl', AAPL], ['usdg', USDG] ] as const) {
    const [metadata, multiplier, pending, effective, paused] = await Promise.all([
      readContract({ address, abi: erc20Abi, functionName: 'name' }),
      label === 'aapl' ? readContract({ address, abi: tokenAbi, functionName: 'uiMultiplier' }).catch(() => undefined) : Promise.resolve(undefined),
      label === 'aapl' ? readContract({ address, abi: tokenAbi, functionName: 'newUIMultiplier' }).catch(() => undefined) : Promise.resolve(undefined),
      label === 'aapl' ? readContract({ address, abi: tokenAbi, functionName: 'effectiveAt' }).catch(() => undefined) : Promise.resolve(undefined),
      label === 'aapl' ? readContract({ address, abi: tokenAbi, functionName: 'oraclePaused' }).catch(() => undefined) : Promise.resolve(undefined),
    ]);
    const [symbol, decimals, totalSupply] = await Promise.all([
      readContract({ address, abi: erc20Abi, functionName: 'symbol' }),
      readContract({ address, abi: erc20Abi, functionName: 'decimals' }),
      readContract({ address, abi: erc20Abi, functionName: 'totalSupply' }),
    ]);
    const implementation = label === 'aapl' ? AAPL_IMPLEMENTATION : USDG_IMPLEMENTATION;
    const implementationCode = await client.getCode({ address: implementation, blockNumber: block.number });
    token[label] = { address, implementation, implementationCodeBytes: implementationCode ? (implementationCode.length - 2) / 2 : 0, implementationCodeKeccak256: implementationCode && implementationCode !== '0x' ? keccak256(implementationCode) : undefined, name: metadata, symbol, decimals, totalSupplyRaw: totalSupply.toString(), ...(label === 'aapl' ? { uiMultiplier: multiplier?.toString(), newUIMultiplier: pending?.toString(), effectiveAt: effective?.toString(), oraclePaused: paused } : {}) };
  }

  const feeds: Record<string, unknown> = {};
  for (const [label, address] of [['aapl', AAPL_FEED], ['usdg', USDG_FEED] ] as const) {
    const [decimals, round] = await Promise.all([
      readContract({ address, abi: feedAbi, functionName: 'decimals' }),
      readContract({ address, abi: feedAbi, functionName: 'latestRoundData' }),
    ]);
    feeds[label] = { address, decimals, round: asRound(round as readonly [bigint, bigint, bigint, bigint, bigint]), officialHeartbeatSeconds: 86400 };
  }

  const [catalog, prices, rdd] = await Promise.all([
    getJson('https://api.robinhood.com/rhj/assets'),
    getJson('https://api.robinhood.com/rhj/prices/AAPL'),
    getJson('https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json'),
  ]);
  const aaplCatalog = (catalog as any)?.assets?.find((x: any) => x.tokenSymbol === 'AAPL');
  const aaplPrice = (prices as any)?.quotes?.find((x: any) => x.tokenSymbol === 'AAPL');
  const aaplRdd = (rdd as any[])?.find((x: any) => x.proxyAddress?.toLowerCase() === AAPL_FEED.toLowerCase());
  const usdgRdd = (rdd as any[])?.find((x: any) => x.proxyAddress?.toLowerCase() === USDG_FEED.toLowerCase());

  const oneUsdG = 1_000_000n;
  const oneAapl = 10n ** 18n;
  const fee = 3000;
  const [buyQuote, sellQuote] = await Promise.all([
    readContract({ address: V3_QUOTER, abi: quoterAbi, functionName: 'quoteExactInputSingle', args: [{ tokenIn: USDG, tokenOut: AAPL, amountIn: 100n * oneUsdG, fee, sqrtPriceLimitX96: 0n }] }).catch((e: unknown) => ({ error: shortError(e) })),
    readContract({ address: V3_QUOTER, abi: quoterAbi, functionName: 'quoteExactInputSingle', args: [{ tokenIn: AAPL, tokenOut: USDG, amountIn: oneAapl, fee, sqrtPriceLimitX96: 0n }] }).catch((e: unknown) => ({ error: shortError(e) })),
  ]);

  // Chainlink's official RDD has no 4663 sequencer-uplift entry. The known
  // Arbitrum mainnet address is probed only to make accidental reuse visible.
  const arbitrumSequencer = '0xFdB631F5EE196F0ed6FAa767959853A9F217697D' as Address;
  const arbitrumSequencerCode = await client.getCode({ address: arbitrumSequencer, blockNumber: block.number });
  const sourceSha: Record<string, string> = {};
  const sourceFiles = [
    'contracts/src/StewardAccountV1.sol', 'contracts/src/StewardTradeAdapterV1.sol',
    'contracts/src/StewardUniswapV3VenueV1.sol', 'contracts/src/StewardChainlinkPriceSourceV1.sol',
    'server/src/integrations/live-chain.ts', 'server/src/integrations/robinhood.ts',
    'config/live-manifest.example.json', 'docs/BACKEND-SPEC.md',
  ];
  for (const path of sourceFiles) if (existsSync(path)) sourceSha[path] = await sha256(path);
  let gitHead: string | undefined;
  try { gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* evidence still useful outside git */ }

  const snapshot: Snapshot = {
    observedAtUtc: new Date().toISOString(), mode: runLocalNegative ? 'public-read-only+local-fork-negative' : 'public-read-only', rpc: RPC, chainId: CHAIN_ID,
    block: blockResult, source: { gitHead, sha256: sourceSha }, addresses, code,
    token,
    feeds: { ...feeds, chainlinkRddUrl: 'https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json', aaplRdd, usdgRdd },
    catalog: { endpoint: 'https://api.robinhood.com/rhj/assets', aapl: aaplCatalog },
    prices: { endpoint: 'https://api.robinhood.com/rhj/prices/AAPL', aapl: aaplPrice },
    venue: { router: V3_ROUTER, quoter: V3_QUOTER, fee, buy100Usdg: buyQuote, sell1Aapl: sellQuote },
    sequencer: { status: 'unavailable', reason: 'No Robinhood Chain (4663) uptime feed entry in the official Chainlink RDD; the Arbitrum candidate is not deployed on 4663.', probedArbitrumCandidate: arbitrumSequencer, candidateCodeBytes: arbitrumSequencerCode ? (arbitrumSequencerCode.length - 2) / 2 : 0 },
    accountFork: { status: 'blocked', reason: 'This read-only harness does not execute a Steward account buy/sell fork. A fresh ephemeral account and fork-only funding can be used without a public user wallet. The price source permits an explicit zero sequencer feed; the complete route, liveness policy, and user-market eligibility remain unreviewed.', manifestAccounts: 0, publicTransactions: false },
    ...(runLocalNegative ? { localNegativeCheck: await localSequencerConstructorNegativeCheck(block.number) } : {}),
    checks: {
      chainId: { ok: chainId === CHAIN_ID, value: chainId },
      latestBlock: { ok: Boolean(block.hash), value: blockResult },
      robinhoodCatalogAapl: { ok: Boolean(aaplCatalog), value: aaplCatalog ? 'found' : 'missing' },
      chainlinkRddAapl: { ok: Boolean(aaplRdd && aaplRdd.heartbeat === 86400), value: aaplRdd ? { proxyAddress: aaplRdd.proxyAddress, heartbeat: aaplRdd.heartbeat } : 'missing' },
      chainlinkRddUsdg: { ok: Boolean(usdgRdd && usdgRdd.heartbeat === 86400), value: usdgRdd ? { proxyAddress: usdgRdd.proxyAddress, heartbeat: usdgRdd.heartbeat } : 'missing' },
      sequencerGuard: { ok: false, error: 'No verified 4663 sequencer feed or independently reviewed no-feed liveness policy' },
      accountFork: { ok: false, error: 'Actual Steward account buy/sell fork has not been run' },
    },
  };
  await writeFile(output, JSON.stringify(snapshot, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n');
  console.log(JSON.stringify({ output, chainId, block: blockResult, aapl: aaplCatalog?.tokenSymbol, accountFork: snapshot.accountFork.reason }));
}

if (import.meta.main) await main();
