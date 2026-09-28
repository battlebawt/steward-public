/**
 * Fork-only Base cbBTC/USDC rehearsal through the actual Steward account.
 * Every transaction goes to a locally owned Anvil fork. Generated keys are
 * disposable and never printed, persisted, or sent to the upstream read RPC.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { BaseError, ContractFunctionRevertedError, createPublicClient, createWalletClient, decodeEventLog, defineChain, http, keccak256, parseAbi, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { actionDomain, actionMessage, ACTION_TYPES, ZERO_ADDRESS, type ActionIntent } from '@steward/shared';
import { VerifiedLiveChainGateway, type LiveManifest } from '../server/src/integrations/live-chain';
import { ReadRpcPool } from '../server/src/integrations/rpc';
import { BaseCryptoCatalog } from '../server/src/integrations/base-crypto';

const UPSTREAM = 'https://mainnet.base.org';
const CHAIN_ID = 8453;
const requestedBlock = process.argv.find(value => value.startsWith('--block='))?.slice('--block='.length);
const upstreamChain = defineChain({ id: CHAIN_ID, name: 'Base', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [UPSTREAM] } } });
const upstreamClient = createPublicClient({ chain: upstreamChain, transport: http(UPSTREAM, { retryCount: 0 }) });
if (await upstreamClient.getChainId() !== CHAIN_ID) throw Error('wrong upstream chain');
const observed = await upstreamClient.getBlock(requestedBlock ? { blockNumber: BigInt(requestedBlock) } : {});
if (observed.number === null || !observed.hash) throw Error('upstream block unavailable');
const BLOCK = observed.number;
const BLOCK_HASH = observed.hash;
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address;
const CBBTC = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf' as Address;
const USDC_FEED = '0x7e860098F58bBFC8648a4311b374B1D669a2bc6B' as Address;
const CBBTC_FEED = '0x8C74B2811D2F1aD65517ADB5C65773c1E520ed2f' as Address;
const ROUTER = '0x2626664c2603336E57B271c5C0b26F421741e481' as Address;
const QUOTER = '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a' as Address;
const UNISWAP_FACTORY = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD' as Address;
const POOL = '0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef' as Address;
const DONOR = '0xeC558e484cC9f2210714E345298fdc53B253c27D' as Address; // 3000-fee pool; execute at 500 fee.
const SEQUENCER = '0xBCF85224fc0756B9Fa45aA7892530B47e10b6433' as Address;
const FEE = 500;
const BUY = 10_000_000n;
const FUND = 30_000_000n;
const PORT = 22000 + Math.floor(Math.random() * 10000);
const URL = `http://127.0.0.1:${PORT}`;
const forkChain = defineChain({ id: CHAIN_ID, name: 'Steward local Base fork', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [URL] } } });
const transport = () => http(URL, { timeout: 180_000, retryCount: 0 });
const client = createPublicClient({ chain: forkChain, transport: transport() });
const parent = privateKeyToAccount(generatePrivateKey());
const caregiver = privateKeyToAccount(generatePrivateKey());
const wallet = createWalletClient({ account: parent, chain: forkChain, transport: transport() });
const caregiverWallet = createWalletClient({ account: caregiver, chain: forkChain, transport: transport() });
const erc20 = parseAbi(['function balanceOf(address) view returns(uint256)', 'function transfer(address,uint256) returns(bool)', 'function allowance(address,address) view returns(uint256)']);
const quoter = parseAbi(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) view returns(uint256,uint160,uint32,uint256)']);
const uniswapFactory = parseAbi(['function getPool(address,address,uint24) view returns(address)']);
const pool = parseAbi(['function liquidity() view returns(uint128)']);
const oracle = parseAbi(['function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)', 'function decimals() view returns(uint8)', 'function description() view returns(string)']);
const checks: string[] = [];
const assert = (ok: unknown, label: string) => { if (!ok) throw Error(label); checks.push(label); };
const artifact = async (name: string) => JSON.parse(await readFile(`contracts/out/${name}.sol/${name}.json`, 'utf8'));
const rpc = async (method: string, params: unknown[]) => {
  const response = await fetch(URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(180_000) });
  const body = await response.json() as { result?: unknown; error?: { message?: string } };
  if (body.error) throw Error(`${method}: ${body.error.message}`);
  return body.result;
};
const mined = async (hash: Hex) => {
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== 'success') throw Error(`local transaction reverted: ${hash}`);
  return receipt;
};
const deploy = async (name: string, args: unknown[]) => {
  const a = await artifact(name);
  const receipt = await mined(await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args, gas: 8_000_000n }));
  if (!receipt.contractAddress) throw Error(`${name} deployment missing address`);
  return { address: receipt.contractAddress, abi: a.abi };
};
const sign = (intent: ActionIntent) => caregiver.signTypedData({ domain: actionDomain(intent), types: ACTION_TYPES, primaryType: 'Action', message: actionMessage(intent) });
const codeHash = async (address: Address) => { const code = await client.getCode({ address }); if (!code || code === '0x') throw Error(`code missing at ${address}`); return keccak256(code); };
const tokenPin = async (address: Address) => ({ address, codeHash: await codeHash(address), decimals: await client.readContract({ address, abi: parseAbi(['function decimals() view returns(uint8)']), functionName: 'decimals' }) });
const feedPin = async (address: Address) => {
  const [round, decimals] = await Promise.all([
    client.readContract({ address, abi: oracle, functionName: 'latestRoundData' }),
    client.readContract({ address, abi: oracle, functionName: 'decimals' }),
  ]);
  return { address, codeHash: await codeHash(address), roundId: round[0].toString(), answer: round[1].toString(), updatedAt: round[3].toString(), answeredInRound: round[4].toString(), decimals };
};
const rejected = async (label: string, expectedError: string, fn: () => Promise<unknown>) => {
  let actualError: string | undefined;
  const expectedSelector = keccak256(new TextEncoder().encode(`${expectedError}()`)).slice(0, 10);
  try { await fn(); }
  catch (error) {
    const revert = error instanceof BaseError ? error.walk(cause => cause instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null : null;
    actualError = revert?.data?.errorName ?? revert?.raw?.slice(0, 10);
  }
  assert(actualError === expectedError || actualError === expectedSelector, `${label} (expected ${expectedError}/${expectedSelector}, got ${actualError ?? 'no decoded revert'})`);
};

const proc = Bun.spawn([
  'anvil', '--fork-url', UPSTREAM, '--fork-block-number', String(BLOCK), '--chain-id', String(CHAIN_ID),
  '--host', '127.0.0.1', '--port', String(PORT), '--timeout', '180000', '--compute-units-per-second', '100', '--silent',
], { stdout: 'ignore', stderr: 'pipe' });

try {
  let ready = false;
  for (let i = 0; i < 90; i++) {
    if (proc.exitCode !== null) throw Error(`local Anvil exited: ${(await new Response(proc.stderr).text()).slice(0, 500)}`);
    try { if (await client.getChainId() === CHAIN_ID) { ready = true; break; } } catch { /* starting */ }
    await Bun.sleep(1000);
  }
  assert(ready, 'local fork started on chain 8453');
  const start = await client.getBlock();
  assert(start.number === BLOCK, 'fork block number matched');
  assert(start.hash === BLOCK_HASH, 'fork block hash matched');
  const publicPins = {
    asset: await tokenPin(CBBTC), settlement: await tokenPin(USDC),
    assetFeed: await feedPin(CBBTC_FEED), settlementFeed: await feedPin(USDC_FEED),
    sequencer: await feedPin(SEQUENCER),
    factory: { address: UNISWAP_FACTORY, codeHash: await codeHash(UNISWAP_FACTORY) },
    pool: { address: POOL, codeHash: await codeHash(POOL) },
    router: { address: ROUTER, codeHash: await codeHash(ROUTER) }, quoter: { address: QUOTER, codeHash: await codeHash(QUOTER) },
  };
  assert(BigInt(publicPins.assetFeed.updatedAt) <= start.timestamp && BigInt(publicPins.settlementFeed.updatedAt) <= start.timestamp, 'public feed rounds preceded fork block');
  assert(publicPins.asset.decimals === 8 && publicPins.settlement.decimals === 6, 'token decimals matched cbBTC and USDC');
  assert(await client.readContract({ address: CBBTC_FEED, abi: oracle, functionName: 'description' }) === 'cbBTC / USD SVR price feed', 'cbBTC-specific price feed identified');
  assert(publicPins.sequencer.answer === '0' && BigInt(publicPins.sequencer.updatedAt) <= start.timestamp, 'Base sequencer feed reported up at fork block');
  assert((await client.readContract({ address: UNISWAP_FACTORY, abi: uniswapFactory, functionName: 'getPool', args: [USDC, CBBTC, FEE] })).toLowerCase() === POOL.toLowerCase(), 'Uniswap factory resolved pinned 0.05% pool');
  assert(await client.readContract({ address: POOL, abi: pool, functionName: 'liquidity' }) > 0n, 'pinned pool had nonzero active liquidity');
  await rpc('anvil_setBalance', [parent.address, '0x3635c9adc5dea00000']);
  await rpc('anvil_setBalance', [caregiver.address, '0x3635c9adc5dea00000']);
  await rpc('anvil_setBalance', [DONOR, '0x3635c9adc5dea00000']);
  assert((await client.readContract({ address: USDC, abi: erc20, functionName: 'balanceOf', args: [DONOR] })) >= FUND, 'fork donor pool held enough USDC');

  const source = await deploy('StewardChainlinkPriceSourceV1', [parent.address, SEQUENCER, 3600n, [USDC, CBBTC], [USDC_FEED, CBBTC_FEED], [86400n, 86400n]]);
  const venue = await deploy('StewardUniswapV3VenueV1', [parent.address, ROUTER]);
  const adapter = await deploy('StewardTradeAdapterV1', [USDC, venue.address, source.address, 86400n, 200n, [CBBTC], [CBBTC_FEED]]);
  await mined(await wallet.writeContract({ ...venue, functionName: 'setCaller', args: [adapter.address, true] }));
  for (const [tokenIn, tokenOut] of [[USDC, CBBTC], [CBBTC, USDC]] as const) {
    await mined(await wallet.writeContract({ ...venue, functionName: 'setRoute', args: [tokenIn, tokenOut, FEE] }));
  }
  const sourcePrice = await client.readContract({ ...source, functionName: 'price', args: [CBBTC] }) as readonly [bigint, number, bigint, boolean];
  assert(sourcePrice[0] > 0n && !sourcePrice[3], 'actual CBBTC feed available at fork block');
  const buyFloor = await client.readContract({ ...adapter, functionName: 'independentFloor', args: [USDC, CBBTC, BUY] }) as bigint;
  const quoted = await client.readContract({ address: QUOTER, abi: quoter, functionName: 'quoteExactInputSingle', args: [{ tokenIn: USDC, tokenOut: CBBTC, amountIn: BUY, fee: FEE, sqrtPriceLimitX96: 0n }] }) as readonly [bigint, bigint, number, bigint];
  assert(buyFloor > 0n && quoted[0] >= buyFloor, 'actual venue quote met independent buy floor');

  const factory = await deploy('StewardFactoryV1', []);
  const other = Array.from({ length: 5 }, () => privateKeyToAccount(generatePrivateKey()));
  const config = {
    settlement: USDC, period: 86400n, anchor: 0n, paymentLimit: 50_000_000n, buyLimit: 50_000_000n,
    reserve: 1_000_000n, perPayment: 20_000_000n, perBuy: 20_000_000n, perSell: 1n * 10n ** 8n,
    exceptionQuorum: 2n, approvedTokens: [CBBTC], paymentRecipients: [parent.address],
    exceptionSigners: other.slice(0, 2).map(a => a.address), guardians: other.slice(2).map(a => a.address), approvedAdapters: [adapter.address],
    sellCapTokens: [CBBTC], sellCaps: [1n * 10n ** 8n], continuityReviewer: ZERO_ADDRESS,
    continuitySuccessor: ZERO_ADDRESS, continuityPlanHash: `0x${'00'.repeat(32)}`,
  };
  const created = await mined(await wallet.writeContract({ ...factory, functionName: 'createAccount', args: [parent.address, config], gas: 8_000_000n }));
  const event = created.logs.map(log => { try { return decodeEventLog({ abi: factory.abi, data: log.data, topics: log.topics }) as any; } catch { return null; } }).find(value => value?.eventName === 'AccountCreated');
  assert(event?.args?.account, 'factory emitted account address');
  const account = { address: event.args.account as Address, abi: (await artifact('StewardAccountV1')).abi };
  const donor = createWalletClient({ account: DONOR, chain: forkChain, transport: transport() });
  await rpc('anvil_impersonateAccount', [DONOR]);
  await mined(await donor.writeContract({ address: USDC, abi: erc20, functionName: 'transfer', args: [account.address, FUND] }));
  assert(await client.readContract({ address: USDC, abi: erc20, functionName: 'balanceOf', args: [account.address] }) === FUND, 'fork account funded with USDC');
  const now = (await client.getBlock()).timestamp;
  await mined(await wallet.writeContract({ ...account, functionName: 'setDelegate', args: [caregiver.address, 6n, now + 86400n, 1n * 10n ** 8n] }));
  const policy = await client.readContract({ ...account, functionName: 'policy' }) as readonly bigint[];
  const version = policy[10]!.toString();
  const routeHash = await client.readContract({ ...adapter, functionName: 'routeHash', args: [USDC, CBBTC] }) as Hex;
  const implementation = await client.readContract({ ...factory, functionName: 'implementation' }) as Address;
  const accountCode = await client.getCode({ address: account.address });
  const adapterCode = await client.getCode({ address: adapter.address });
  const implementationCode = await client.getCode({ address: implementation });
  const factoryCode = await client.getCode({ address: factory.address });
  assert([accountCode, adapterCode, implementationCode, factoryCode].every(code => !!code && code !== '0x'), 'deployed fork contracts have code');
  const manifest: LiveManifest = {
    chainId: CHAIN_ID, version: 'fork-only-2026-09-24',
    accounts: [{ address: account.address, runtimeCodeHash: keccak256(accountCode!), settlement: USDC, deploymentBlock: created.blockNumber.toString(), implementation, implementationCodeHash: keccak256(implementationCode!) }],
    routes: [{ asset: CBBTC, provider: 'coinbase', legalInstrumentType: 'wrapped_bitcoin', sourceTermsVersion: 'fork-fixture-2026-09-24', adapter: adapter.address, adapterCodeHash: keccak256(adapterCode!), quoter: QUOTER, fee: FEE, session: 'market' }],
    factory: { address: factory.address, runtimeCodeHash: keccak256(factoryCode!), implementation, implementationCodeHash: keccak256(implementationCode!) },
  };
  // This exact-account callback exists only inside the disposable fork process.
  // Production still requires a real eligibility/session authority and has no callback.
  const catalog = new BaseCryptoCatalog(CHAIN_ID);
  const catalogAsset = (await catalog.assets()).find(asset => asset.address.toLowerCase() === CBBTC.toLowerCase());
  assert(!!catalogAsset?.active && catalogAsset.sessions.market === 'tradable', 'Base cbBTC catalog route is configured for fork rehearsal');
  const gateway = new VerifiedLiveChainGateway({
    rpc: new ReadRpcPool([URL], CHAIN_ID, fetch, () => Number(now) * 1000, 3600),
    manifest, catalog,
    marketGate: async input => ({
      allowed: input.account.toLowerCase() === account.address.toLowerCase()
        && input.actor.toLowerCase() === caregiver.address.toLowerCase()
        && input.asset.toLowerCase() === CBBTC.toLowerCase() && input.chainId === CHAIN_ID && input.policyVersion === version
        && input.session === 'market' && (input.side === 'BUY' || input.side === 'SELL'),
      reason: 'local-fork-fixture', source: 'local-fork-fixture', observedAt: Date.now(), expiresAt: Date.now() + 30_000,
    }),
  });
  const backendBuyQuote = await gateway.quote({ account: account.address, actor: caregiver.address, kind: 'BUY', asset: CBBTC, amountInRaw: BUY.toString() });
  assert(backendBuyQuote.minAmountOutRaw === buyFloor.toString() && backendBuyQuote.routeHash === routeHash, 'backend buy quote matched independent floor and route');
  const base: Omit<ActionIntent, 'actionId' | 'kind' | 'nonce' | 'tokenIn' | 'tokenOut' | 'amountInRaw' | 'minAmountOutRaw' | 'routeHash'> = {
    account: account.address, actor: caregiver.address, chainId: CHAIN_ID, securityEpoch: '1', policyVersion: version,
    recipient: account.address, adapter: adapter.address, validAfter: String(now - 1n), deadline: String((now>BigInt(Math.floor(Date.now()/1000))?now:BigInt(Math.floor(Date.now()/1000))) + 3600n), exceptionMask: '0',
  };
  const buy: ActionIntent = { ...base, actionId: `0x${'01'.repeat(32)}`, kind: 'BUY', nonce: '1', tokenIn: USDC, tokenOut: CBBTC, amountInRaw: BUY.toString(), minAmountOutRaw: backendBuyQuote.minAmountOutRaw, routeHash: backendBuyQuote.routeHash };
  const buySig = await sign(buy);
  const beforeCbbtc = await client.readContract({ address: CBBTC, abi: erc20, functionName: 'balanceOf', args: [account.address] });
  const preparedBuy = await gateway.prepareAction(buy, [{ signer: caregiver.address, signature: buySig }]);
  assert(preparedBuy.to.toLowerCase() === account.address.toLowerCase() && preparedBuy.simulation.ok, 'backend prepared and simulated guarded buy');
  const buyReceipt = await mined(await caregiverWallet.sendTransaction({ to: preparedBuy.to, data: preparedBuy.data, value: 0n, gas: 3_000_000n }));
  const afterCbbtc = await client.readContract({ address: CBBTC, abi: erc20, functionName: 'balanceOf', args: [account.address] });
  assert(afterCbbtc > beforeCbbtc && afterCbbtc - beforeCbbtc >= buyFloor, 'actual CBBTC buy met floor');
  assert(await client.readContract({ address: USDC, abi: erc20, functionName: 'balanceOf', args: [account.address] }) === FUND - BUY, 'buy debited exact USDC input');
  assert(await client.readContract({ ...account, functionName: 'buySpent', args: [await client.readContract({ ...account, functionName: 'periodStart' })] }) === BUY, 'buy budget recorded exact input');
  assert(await client.readContract({ address: USDC, abi: erc20, functionName: 'allowance', args: [account.address, adapter.address] }) === 0n, 'buy cleared account allowance');
  assert(await client.readContract({ address: USDC, abi: erc20, functionName: 'allowance', args: [adapter.address, venue.address] }) === 0n, 'buy cleared adapter allowance');
  const lowFloor: ActionIntent = { ...buy, actionId: `0x${'02'.repeat(32)}`, nonce: '2', minAmountOutRaw: (buyFloor - 1n).toString() };
  await rejected('independent buy floor rejects weakened minimum', 'Slippage', async () => client.simulateContract({ ...account, account: parent.address, functionName: 'executeTrade', args: [actionMessage(lowFloor), [await sign(lowFloor)]] }));
  const overCap: ActionIntent = { ...buy, actionId: `0x${'03'.repeat(32)}`, nonce: '3', amountInRaw: '20000001', minAmountOutRaw: (await client.readContract({ ...adapter, functionName: 'independentFloor', args: [USDC, CBBTC, 20_000_001n] }) as bigint).toString() };
  await rejected('caregiver buy cap rejects oversized action', 'CapExceeded', async () => client.simulateContract({ ...account, account: parent.address, functionName: 'executeTrade', args: [actionMessage(overCap), [await sign(overCap)]] }));
  const wrongRoute: ActionIntent = { ...buy, actionId: `0x${'06'.repeat(32)}`, nonce: '6', routeHash: `0x${'ff'.repeat(32)}` };
  await rejected('signed action cannot change the approved execution route', 'Unsupported', async () => client.simulateContract({ ...account, account: parent.address, functionName: 'executeTrade', args: [actionMessage(wrongRoute), [await sign(wrongRoute)]] }));
  const expired: ActionIntent = { ...buy, actionId: `0x${'07'.repeat(32)}`, nonce: '7', validAfter: String(now - 100n), deadline: String(now - 1n) };
  await rejected('expired signed caregiver action cannot execute', 'Expired', async () => client.simulateContract({ ...account, account: parent.address, functionName: 'executeTrade', args: [actionMessage(expired), [await sign(expired)]] }));
  const unsigned: ActionIntent = { ...buy, actionId: `0x${'09'.repeat(32)}`, nonce: '9' };
  await rejected('caregiver signature is mandatory', 'BadApprovals', async () => client.simulateContract({ ...account, account: parent.address, functionName: 'executeTrade', args: [actionMessage(unsigned), []] }));
  const coSigned: ActionIntent = { ...buy, actionId: `0x${'08'.repeat(32)}`, nonce: '8', exceptionMask: '6' };
  const coSignerSignatures = await Promise.all(other.slice(0, 2).map(a => a.signTypedData({ domain: actionDomain(coSigned), types: ACTION_TYPES, primaryType: 'Action', message: actionMessage(coSigned) })));
  await rejected('exception requires both configured co-signers', 'BadApprovals', async () => client.simulateContract({ ...account, account: parent.address, functionName: 'executeTrade', args: [actionMessage(coSigned), [await sign(coSigned), coSignerSignatures[0]!]] }));
  assert((await client.simulateContract({ ...account, account: parent.address, functionName: 'executeTrade', args: [actionMessage(coSigned), [await sign(coSigned), ...coSignerSignatures]] })).result > 0n, 'two configured co-signers authorize exact exception action');

  const sellAmount = (afterCbbtc - beforeCbbtc) / 2n;
  assert(sellAmount > 0n, 'CBBTC output sufficient to sell');
  const sellFloor = await client.readContract({ ...adapter, functionName: 'independentFloor', args: [CBBTC, USDC, sellAmount] }) as bigint;
  const sellQuote = await client.readContract({ address: QUOTER, abi: quoter, functionName: 'quoteExactInputSingle', args: [{ tokenIn: CBBTC, tokenOut: USDC, amountIn: sellAmount, fee: FEE, sqrtPriceLimitX96: 0n }] }) as readonly [bigint, bigint, number, bigint];
  assert(sellQuote[0] >= sellFloor, 'actual venue quote met independent sell floor');
  const backendSellQuote = await gateway.quote({ account: account.address, actor: caregiver.address, kind: 'SELL', asset: CBBTC, amountInRaw: sellAmount.toString() });
  assert(backendSellQuote.minAmountOutRaw === sellFloor.toString(), 'backend sell quote matched independent floor');
  const sell: ActionIntent = { ...base, actionId: `0x${'04'.repeat(32)}`, kind: 'SELL', nonce: '4', tokenIn: CBBTC, tokenOut: USDC, amountInRaw: sellAmount.toString(), minAmountOutRaw: backendSellQuote.minAmountOutRaw, routeHash: backendSellQuote.routeHash };
  const beforeUsdc = await client.readContract({ address: USDC, abi: erc20, functionName: 'balanceOf', args: [account.address] });
  const preparedSell = await gateway.prepareAction(sell, [{ signer: caregiver.address, signature: await sign(sell) }]);
  assert(preparedSell.to.toLowerCase() === account.address.toLowerCase() && preparedSell.simulation.ok, 'backend prepared and simulated guarded sell');
  const sellReceipt = await mined(await caregiverWallet.sendTransaction({ to: preparedSell.to, data: preparedSell.data, value: 0n, gas: 3_000_000n }));
  const afterUsdc = await client.readContract({ address: USDC, abi: erc20, functionName: 'balanceOf', args: [account.address] });
  const afterSellCbbtc = await client.readContract({ address: CBBTC, abi: erc20, functionName: 'balanceOf', args: [account.address] });
  assert(afterUsdc > beforeUsdc && afterUsdc - beforeUsdc >= sellFloor, 'actual USDC sell met floor');
  assert(afterCbbtc - afterSellCbbtc === sellAmount, 'sell debited exact cbBTC input');
  assert(await client.readContract({ ...account, functionName: 'sellSpent', args: [CBBTC, await client.readContract({ ...account, functionName: 'periodStart' })] }) === sellAmount, 'sell budget recorded exact cbBTC input');
  assert(await client.readContract({ address: CBBTC, abi: erc20, functionName: 'allowance', args: [account.address, adapter.address] }) === 0n, 'sell cleared account allowance');
  assert(await client.readContract({ address: CBBTC, abi: erc20, functionName: 'allowance', args: [adapter.address, venue.address] }) === 0n, 'sell cleared adapter allowance');
  await mined(await wallet.writeContract({ ...account, functionName: 'revokeDelegate', args: [caregiver.address] }));
  const revokedVersion = (await client.readContract({ ...account, functionName: 'policy' }) as readonly bigint[])[10]!.toString();
  const afterRevoke: ActionIntent = { ...buy, actionId: `0x${'05'.repeat(32)}`, nonce: '5', policyVersion: revokedVersion };
  await rejected('revoked caregiver cannot trade', 'Unauthorized', async () => client.simulateContract({ ...account, account: parent.address, functionName: 'executeTrade', args: [actionMessage(afterRevoke), [await sign(afterRevoke)]] }));
  await rpc('evm_increaseTime', [86401]);
  await rpc('evm_mine', []);
  await rejected('stale actual feed blocks adapter quote', 'BadPrice', async () => client.readContract({ ...adapter, functionName: 'quote', args: [USDC, CBBTC, BUY] }));
  const evidence = {
    status: 'passed', realFunds: false, publicTransactions: false, chainId: CHAIN_ID,
    fork: { upstream: UPSTREAM, blockNumber: BLOCK.toString(), blockHash: start.hash },
    sourceRevision: (await Bun.$`git rev-parse HEAD`.quiet().text()).trim(),
    publicPins,
    feedFreshnessAtFork: { assetAgeSeconds: (start.timestamp - BigInt(publicPins.assetFeed.updatedAt)).toString(), settlementAgeSeconds: (start.timestamp - BigInt(publicPins.settlementFeed.updatedAt)).toString(), selectedMaxAgeSeconds: 86400, basis: 'fork-only threshold admitting observed rounds; production heartbeat and risk tolerance not validated' },
    catalogFixture: { asset: CBBTC, active: catalogAsset!.active, routeCapability: catalogAsset!.sessions.market, eligibility: catalogAsset!.eligibility },
    route: { asset: CBBTC, settlement: USDC, assetFeed: CBBTC_FEED, settlementFeed: USDC_FEED, factory: UNISWAP_FACTORY, pool: POOL, router: ROUTER, quoter: QUOTER, fee: FEE, maxPriceAgeSeconds: 86400, slippageBps: 200, sequencerFeed: SEQUENCER },
    localContracts: { source: source.address, venue: venue.address, adapter: adapter.address, factory: factory.address, account: account.address },
    localTransactions: { buy: buyReceipt.transactionHash, sell: sellReceipt.transactionHash },
    backendPath: { gateway: 'VerifiedLiveChainGateway', catalog: 'pinned Base cbBTC catalog', marketGate: 'fork-only exact-account/actor fixture', buyAndSellPreparedAndSimulated: true },
    measured: { fundedUsdcRaw: FUND.toString(), boughtCbbtcRaw: (afterCbbtc - beforeCbbtc).toString(), buyFloorRaw: buyFloor.toString(), soldCbbtcRaw: sellAmount.toString(), receivedUsdcRaw: (afterUsdc - beforeUsdc).toString(), sellFloorRaw: sellFloor.toString() },
    checks,
    limitations: ['Fork-only, valueless rehearsal; no public mainnet transaction', 'Pool donor was impersonated only inside Anvil', 'Static catalog plus exact-account fork admission fixture; no production admission source', 'No legal, independent security, physical-device, or production-operations approval'],
  };
  const output = process.argv.find(value => value.startsWith('--output='))?.slice('--output='.length);
  if (output) await writeFile(output, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ status: evidence.status, checks: checks.length, forkBlock: evidence.fork.blockNumber, boughtCbbtcRaw: evidence.measured.boughtCbbtcRaw, soldCbbtcRaw: evidence.measured.soldCbbtcRaw, publicTransactions: false, output: output ?? null }));
} finally {
  proc.kill();
  await proc.exited;
}
