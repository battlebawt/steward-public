/**
 * Fork-only Robinhood AAPL/USDG rehearsal through the actual Steward account.
 * Every transaction goes to a locally owned Anvil fork. Generated keys are
 * disposable and never printed, persisted, or sent to the upstream read RPC.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { BaseError, ContractFunctionRevertedError, createPublicClient, createWalletClient, decodeEventLog, defineChain, http, keccak256, parseAbi, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { actionDomain, actionMessage, ACTION_TYPES, ZERO_ADDRESS, type ActionIntent } from '@steward/shared';
import { VerifiedLiveChainGateway, type LiveManifest } from '../server/src/integrations/live-chain';
import { ReadRpcPool } from '../server/src/integrations/rpc';
import { RobinhoodCatalog } from '../server/src/integrations/robinhood';
import { EIP1967_IMPLEMENTATION_SLOT } from '../server/src/integrations/valuation';

const UPSTREAM = 'https://rpc.mainnet.chain.robinhood.com';
const CHAIN_ID = 4663;
const requestedBlock = process.argv.find(value => value.startsWith('--block='))?.slice('--block='.length);
const upstreamChain = defineChain({ id: CHAIN_ID, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [UPSTREAM] } } });
const upstreamClient = createPublicClient({ chain: upstreamChain, transport: http(UPSTREAM, { retryCount: 0 }) });
if (await upstreamClient.getChainId() !== CHAIN_ID) throw Error('wrong upstream chain');
const observed = await upstreamClient.getBlock(requestedBlock ? { blockNumber: BigInt(requestedBlock) } : {});
if (observed.number === null || !observed.hash) throw Error('upstream block unavailable');
const BLOCK = observed.number;
const BLOCK_HASH = observed.hash;
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address;
const AAPL = '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9' as Address;
const AAPL_IMPLEMENTATION = '0xe10b6F6b275de231345c20D14ab812Db62151b00' as Address;
const USDG_IMPLEMENTATION = '0x68184c449e1A8f34fA18d289737129Fd27b66F8f' as Address;
const USDG_FEED = '0x61B7e5650328764B076A108EFF5fa7282a1B9aD2' as Address;
const AAPL_FEED = '0x6B22A786bAa607d76728168703a39Ea9C99f2cD0' as Address;
const ROUTER = '0xCaf681a66D020601342297493863E78C959E5cb2' as Address;
const QUOTER = '0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7' as Address;
const DONOR = '0x783c9bbb765047cfdd2b84b92b2ca9f11d34b7ed' as Address; // 3000-fee pool; execute at 500 fee.
const FEE = 500;
const BUY = 10_000_000n;
const FUND = 30_000_000n;
const PORT = 22000 + Math.floor(Math.random() * 10000);
const URL = `http://127.0.0.1:${PORT}`;
const forkChain = defineChain({ id: CHAIN_ID, name: 'Steward local Robinhood fork', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [URL] } } });
const transport = () => http(URL, { timeout: 180_000, retryCount: 0 });
const client = createPublicClient({ chain: forkChain, transport: transport() });
const parent = privateKeyToAccount(generatePrivateKey());
const caregiver = privateKeyToAccount(generatePrivateKey());
const wallet = createWalletClient({ account: parent, chain: forkChain, transport: transport() });
const caregiverWallet = createWalletClient({ account: caregiver, chain: forkChain, transport: transport() });
const erc20 = parseAbi(['function balanceOf(address) view returns(uint256)', 'function transfer(address,uint256) returns(bool)', 'function allowance(address,address) view returns(uint256)']);
const quoter = parseAbi(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) view returns(uint256,uint160,uint32,uint256)']);
const oracle = parseAbi(['function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)', 'function decimals() view returns(uint8)']);
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
const tokenPin = async (address: Address, implementation: Address, pointer: 'immutable' | 'eip1967') => {
  const code = await client.getCode({ address });
  if (!code || code === '0x') throw Error(`token code missing at ${address}`);
  if (pointer === 'immutable') {
    // AAPL embeds its implementation pointer in the proxy runtime, not an EIP-1967 slot.
    if (!code.toLowerCase().includes(`000000000000000000000000${implementation.slice(2).toLowerCase()}`)) throw Error('AAPL implementation pointer changed');
  } else {
    const slot = await client.getStorageAt({ address, slot: EIP1967_IMPLEMENTATION_SLOT });
    if (!slot || `0x${slot.slice(-40)}`.toLowerCase() !== implementation.toLowerCase()) throw Error('USDG implementation pointer changed');
  }
  return { address, codeHash: keccak256(code), pointer, implementationSlot: pointer === 'eip1967' ? EIP1967_IMPLEMENTATION_SLOT : null, implementation, implementationCodeHash: await codeHash(implementation) };
};
const feedPin = async (address: Address) => {
  const [round, decimals] = await Promise.all([
    client.readContract({ address, abi: oracle, functionName: 'latestRoundData' }),
    client.readContract({ address, abi: oracle, functionName: 'decimals' }),
  ]);
  return { address, codeHash: await codeHash(address), roundId: round[0].toString(), answer: round[1].toString(), updatedAt: round[3].toString(), answeredInRound: round[4].toString(), decimals };
};
const rejected = async (label: string, fn: () => Promise<unknown>) => {
  let reverted = false;
  try { await fn(); }
  catch (error) { reverted = error instanceof BaseError && !!error.walk(cause => cause instanceof ContractFunctionRevertedError); }
  assert(reverted, label);
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
  assert(ready, 'local fork started on chain 4663');
  const start = await client.getBlock();
  assert(start.number === BLOCK, 'fork block number matched');
  assert(start.hash === BLOCK_HASH, 'fork block hash matched');
  const publicPins = {
    stock: await tokenPin(AAPL, AAPL_IMPLEMENTATION, 'immutable'), settlement: await tokenPin(USDG, USDG_IMPLEMENTATION, 'eip1967'),
    stockFeed: await feedPin(AAPL_FEED), settlementFeed: await feedPin(USDG_FEED),
    router: { address: ROUTER, codeHash: await codeHash(ROUTER) }, quoter: { address: QUOTER, codeHash: await codeHash(QUOTER) },
  };
  assert(BigInt(publicPins.stockFeed.updatedAt) <= start.timestamp && BigInt(publicPins.settlementFeed.updatedAt) <= start.timestamp, 'public feed rounds preceded fork block');
  await rpc('anvil_setBalance', [parent.address, '0x3635c9adc5dea00000']);
  await rpc('anvil_setBalance', [caregiver.address, '0x3635c9adc5dea00000']);
  await rpc('anvil_setBalance', [DONOR, '0x3635c9adc5dea00000']);
  assert((await client.readContract({ address: USDG, abi: erc20, functionName: 'balanceOf', args: [DONOR] })) >= FUND, 'fork donor pool held enough USDG');

  const source = await deploy('StewardChainlinkPriceSourceV1', [parent.address, ZERO_ADDRESS, 0n, [USDG, AAPL], [USDG_FEED, AAPL_FEED], [86400n, 86400n]]);
  const venue = await deploy('StewardUniswapV3VenueV1', [parent.address, ROUTER]);
  const adapter = await deploy('StewardTradeAdapterV1', [USDG, venue.address, source.address, 86400n, 200n, [AAPL], [AAPL_FEED]]);
  await mined(await wallet.writeContract({ ...venue, functionName: 'setCaller', args: [adapter.address, true] }));
  for (const [tokenIn, tokenOut] of [[USDG, AAPL], [AAPL, USDG]] as const) {
    await mined(await wallet.writeContract({ ...venue, functionName: 'setRoute', args: [tokenIn, tokenOut, FEE] }));
  }
  const sourcePrice = await client.readContract({ ...source, functionName: 'price', args: [AAPL] }) as readonly [bigint, number, bigint, boolean];
  assert(sourcePrice[0] > 0n && !sourcePrice[3], 'actual AAPL feed available at fork block');
  const buyFloor = await client.readContract({ ...adapter, functionName: 'independentFloor', args: [USDG, AAPL, BUY] }) as bigint;
  const quoted = await client.readContract({ address: QUOTER, abi: quoter, functionName: 'quoteExactInputSingle', args: [{ tokenIn: USDG, tokenOut: AAPL, amountIn: BUY, fee: FEE, sqrtPriceLimitX96: 0n }] }) as readonly [bigint, bigint, number, bigint];
  assert(buyFloor > 0n && quoted[0] >= buyFloor, 'actual venue quote met independent buy floor');

  const factory = await deploy('StewardFactoryV1', []);
  const other = Array.from({ length: 5 }, () => privateKeyToAccount(generatePrivateKey()).address);
  const config = {
    settlement: USDG, period: 86400n, anchor: 0n, paymentLimit: 50_000_000n, buyLimit: 50_000_000n,
    reserve: 1_000_000n, perPayment: 20_000_000n, perBuy: 20_000_000n, perSell: 1n * 10n ** 18n,
    exceptionQuorum: 2n, approvedTokens: [AAPL], paymentRecipients: [parent.address],
    exceptionSigners: other.slice(0, 2), guardians: other.slice(2), approvedAdapters: [adapter.address],
    sellCapTokens: [AAPL], sellCaps: [1n * 10n ** 18n], continuityReviewer: ZERO_ADDRESS,
    continuitySuccessor: ZERO_ADDRESS, continuityPlanHash: `0x${'00'.repeat(32)}`,
  };
  const created = await mined(await wallet.writeContract({ ...factory, functionName: 'createAccount', args: [parent.address, config], gas: 8_000_000n }));
  const event = created.logs.map(log => { try { return decodeEventLog({ abi: factory.abi, data: log.data, topics: log.topics }) as any; } catch { return null; } }).find(value => value?.eventName === 'AccountCreated');
  assert(event?.args?.account, 'factory emitted account address');
  const account = { address: event.args.account as Address, abi: (await artifact('StewardAccountV1')).abi };
  const donor = createWalletClient({ account: DONOR, chain: forkChain, transport: transport() });
  await rpc('anvil_impersonateAccount', [DONOR]);
  await mined(await donor.writeContract({ address: USDG, abi: erc20, functionName: 'transfer', args: [account.address, FUND] }));
  assert(await client.readContract({ address: USDG, abi: erc20, functionName: 'balanceOf', args: [account.address] }) === FUND, 'fork account funded with USDG');
  const now = (await client.getBlock()).timestamp;
  await mined(await wallet.writeContract({ ...account, functionName: 'setDelegate', args: [caregiver.address, 6n, now + 86400n, 1n * 10n ** 18n] }));
  const policy = await client.readContract({ ...account, functionName: 'policy' }) as readonly bigint[];
  const version = policy[10]!.toString();
  const routeHash = await client.readContract({ ...adapter, functionName: 'routeHash', args: [USDG, AAPL] }) as Hex;
  const implementation = await client.readContract({ ...factory, functionName: 'implementation' }) as Address;
  const accountCode = await client.getCode({ address: account.address });
  const adapterCode = await client.getCode({ address: adapter.address });
  const implementationCode = await client.getCode({ address: implementation });
  const factoryCode = await client.getCode({ address: factory.address });
  assert([accountCode, adapterCode, implementationCode, factoryCode].every(code => !!code && code !== '0x'), 'deployed fork contracts have code');
  const manifest: LiveManifest = {
    chainId: CHAIN_ID, version: 'fork-only-2026-09-23',
    accounts: [{ address: account.address, runtimeCodeHash: keccak256(accountCode!), settlement: USDG, deploymentBlock: created.blockNumber.toString(), implementation, implementationCodeHash: keccak256(implementationCode!) }],
    routes: [{ asset: AAPL, provider: 'robinhood', legalInstrumentType: 'tokenized_debt_security', sourceTermsVersion: 'fork-fixture-2026-09-23', adapter: adapter.address, adapterCodeHash: keccak256(adapterCode!), quoter: QUOTER, fee: FEE, session: 'market' }],
    factory: { address: factory.address, runtimeCodeHash: keccak256(factoryCode!), implementation, implementationCodeHash: keccak256(implementationCode!) },
  };
  // This exact-account callback exists only inside the disposable fork process.
  // Production still requires a real eligibility/session authority and has no callback.
  const catalog = new RobinhoodCatalog(CHAIN_ID);
  const catalogAsset = (await catalog.assets()).find(asset => asset.address.toLowerCase() === AAPL.toLowerCase());
  assert(!!catalogAsset?.active && catalogAsset.sessions.market === 'tradable', 'live catalog showed active market tradability at rehearsal time');
  const gateway = new VerifiedLiveChainGateway({
    rpc: new ReadRpcPool([URL], CHAIN_ID, fetch, () => Number(now) * 1000, 3600),
    manifest, catalog,
    marketGate: async input => ({
      allowed: input.account.toLowerCase() === account.address.toLowerCase()
        && input.actor.toLowerCase() === caregiver.address.toLowerCase()
        && input.asset.toLowerCase() === AAPL.toLowerCase() && input.chainId === CHAIN_ID && input.policyVersion === version
        && input.session === 'market' && (input.side === 'BUY' || input.side === 'SELL'),
      reason: 'local-fork-fixture', source: 'local-fork-fixture', observedAt: Date.now(), expiresAt: Date.now() + 30_000,
    }),
  });
  const backendBuyQuote = await gateway.quote({ account: account.address, actor: caregiver.address, kind: 'BUY', asset: AAPL, amountInRaw: BUY.toString() });
  assert(backendBuyQuote.minAmountOutRaw === buyFloor.toString() && backendBuyQuote.routeHash === routeHash, 'backend buy quote matched independent floor and route');
  const base: Omit<ActionIntent, 'actionId' | 'kind' | 'nonce' | 'tokenIn' | 'tokenOut' | 'amountInRaw' | 'minAmountOutRaw' | 'routeHash'> = {
    account: account.address, actor: caregiver.address, chainId: CHAIN_ID, securityEpoch: '1', policyVersion: version,
    recipient: account.address, adapter: adapter.address, validAfter: String(now - 1n), deadline: String((now>BigInt(Math.floor(Date.now()/1000))?now:BigInt(Math.floor(Date.now()/1000))) + 3600n), exceptionMask: '0',
  };
  const buy: ActionIntent = { ...base, actionId: `0x${'01'.repeat(32)}`, kind: 'BUY', nonce: '1', tokenIn: USDG, tokenOut: AAPL, amountInRaw: BUY.toString(), minAmountOutRaw: backendBuyQuote.minAmountOutRaw, routeHash: backendBuyQuote.routeHash };
  const buySig = await sign(buy);
  const beforeStock = await client.readContract({ address: AAPL, abi: erc20, functionName: 'balanceOf', args: [account.address] });
  const preparedBuy = await gateway.prepareAction(buy, [{ signer: caregiver.address, signature: buySig }]);
  assert(preparedBuy.to.toLowerCase() === account.address.toLowerCase() && preparedBuy.simulation.ok, 'backend prepared and simulated guarded buy');
  const buyReceipt = await mined(await caregiverWallet.sendTransaction({ to: preparedBuy.to, data: preparedBuy.data, value: 0n, gas: 3_000_000n }));
  const afterStock = await client.readContract({ address: AAPL, abi: erc20, functionName: 'balanceOf', args: [account.address] });
  assert(afterStock > beforeStock && afterStock - beforeStock >= buyFloor, 'actual AAPL buy met floor');
  assert(await client.readContract({ address: USDG, abi: erc20, functionName: 'balanceOf', args: [account.address] }) === FUND - BUY, 'buy debited exact USDG input');
  assert(await client.readContract({ address: USDG, abi: erc20, functionName: 'allowance', args: [account.address, adapter.address] }) === 0n, 'buy cleared account allowance');
  assert(await client.readContract({ address: USDG, abi: erc20, functionName: 'allowance', args: [adapter.address, venue.address] }) === 0n, 'buy cleared adapter allowance');
  const lowFloor: ActionIntent = { ...buy, actionId: `0x${'02'.repeat(32)}`, nonce: '2', minAmountOutRaw: (buyFloor - 1n).toString() };
  await rejected('independent buy floor rejects weakened minimum', async () => client.simulateContract({ ...account, account: parent.address, functionName: 'executeTrade', args: [actionMessage(lowFloor), [await sign(lowFloor)]] }));
  const overCap: ActionIntent = { ...buy, actionId: `0x${'03'.repeat(32)}`, nonce: '3', amountInRaw: '20000001', minAmountOutRaw: (await client.readContract({ ...adapter, functionName: 'independentFloor', args: [USDG, AAPL, 20_000_001n] }) as bigint).toString() };
  await rejected('caregiver buy cap rejects oversized action', async () => client.simulateContract({ ...account, account: parent.address, functionName: 'executeTrade', args: [actionMessage(overCap), [await sign(overCap)]] }));

  const sellAmount = (afterStock - beforeStock) / 2n;
  assert(sellAmount > 0n, 'AAPL output sufficient to sell');
  const sellFloor = await client.readContract({ ...adapter, functionName: 'independentFloor', args: [AAPL, USDG, sellAmount] }) as bigint;
  const sellQuote = await client.readContract({ address: QUOTER, abi: quoter, functionName: 'quoteExactInputSingle', args: [{ tokenIn: AAPL, tokenOut: USDG, amountIn: sellAmount, fee: FEE, sqrtPriceLimitX96: 0n }] }) as readonly [bigint, bigint, number, bigint];
  assert(sellQuote[0] >= sellFloor, 'actual venue quote met independent sell floor');
  const backendSellQuote = await gateway.quote({ account: account.address, actor: caregiver.address, kind: 'SELL', asset: AAPL, amountInRaw: sellAmount.toString() });
  assert(backendSellQuote.minAmountOutRaw === sellFloor.toString(), 'backend sell quote matched independent floor');
  const sell: ActionIntent = { ...base, actionId: `0x${'04'.repeat(32)}`, kind: 'SELL', nonce: '4', tokenIn: AAPL, tokenOut: USDG, amountInRaw: sellAmount.toString(), minAmountOutRaw: backendSellQuote.minAmountOutRaw, routeHash: backendSellQuote.routeHash };
  const beforeUsdG = await client.readContract({ address: USDG, abi: erc20, functionName: 'balanceOf', args: [account.address] });
  const preparedSell = await gateway.prepareAction(sell, [{ signer: caregiver.address, signature: await sign(sell) }]);
  assert(preparedSell.to.toLowerCase() === account.address.toLowerCase() && preparedSell.simulation.ok, 'backend prepared and simulated guarded sell');
  const sellReceipt = await mined(await caregiverWallet.sendTransaction({ to: preparedSell.to, data: preparedSell.data, value: 0n, gas: 3_000_000n }));
  const afterUsdG = await client.readContract({ address: USDG, abi: erc20, functionName: 'balanceOf', args: [account.address] });
  assert(afterUsdG > beforeUsdG && afterUsdG - beforeUsdG >= sellFloor, 'actual USDG sell met floor');
  assert(await client.readContract({ address: AAPL, abi: erc20, functionName: 'allowance', args: [account.address, adapter.address] }) === 0n, 'sell cleared account allowance');
  assert(await client.readContract({ address: AAPL, abi: erc20, functionName: 'allowance', args: [adapter.address, venue.address] }) === 0n, 'sell cleared adapter allowance');
  await mined(await wallet.writeContract({ ...account, functionName: 'revokeDelegate', args: [caregiver.address] }));
  const revokedVersion = (await client.readContract({ ...account, functionName: 'policy' }) as readonly bigint[])[10]!.toString();
  const afterRevoke: ActionIntent = { ...buy, actionId: `0x${'05'.repeat(32)}`, nonce: '5', policyVersion: revokedVersion };
  await rejected('revoked caregiver cannot trade', async () => client.simulateContract({ ...account, account: parent.address, functionName: 'executeTrade', args: [actionMessage(afterRevoke), [await sign(afterRevoke)]] }));
  await rpc('evm_increaseTime', [86401]);
  await rpc('evm_mine', []);
  await rejected('stale actual feed blocks adapter quote', async () => client.readContract({ ...adapter, functionName: 'quote', args: [USDG, AAPL, BUY] }));
  const evidence = {
    status: 'passed', realFunds: false, publicTransactions: false, chainId: CHAIN_ID,
    fork: { upstream: UPSTREAM, blockNumber: BLOCK.toString(), blockHash: start.hash },
    sourceRevision: (await Bun.$`git rev-parse HEAD`.quiet().text()).trim(),
    publicPins,
    catalogAtRehearsal: { observedAtUtc: new Date().toISOString(), stock: AAPL, active: catalogAsset!.active, marketSession: catalogAsset!.sessions.market, eligibility: catalogAsset!.eligibility },
    route: { stock: AAPL, settlement: USDG, stockFeed: AAPL_FEED, settlementFeed: USDG_FEED, router: ROUTER, quoter: QUOTER, fee: FEE, maxPriceAgeSeconds: 86400, slippageBps: 200, sequencerFeed: ZERO_ADDRESS },
    localContracts: { source: source.address, venue: venue.address, adapter: adapter.address, factory: factory.address, account: account.address },
    localTransactions: { buy: buyReceipt.transactionHash, sell: sellReceipt.transactionHash },
    backendPath: { gateway: 'VerifiedLiveChainGateway', catalog: 'live Robinhood asset catalog', marketGate: 'fork-only exact-account/actor fixture', buyAndSellPreparedAndSimulated: true },
    measured: { fundedUsdGRaw: FUND.toString(), boughtAaplRaw: (afterStock - beforeStock).toString(), buyFloorRaw: buyFloor.toString(), soldAaplRaw: sellAmount.toString(), receivedUsdGRaw: (afterUsdG - beforeUsdG).toString(), sellFloorRaw: sellFloor.toString() },
    checks,
    limitations: ['Fork-only, valueless rehearsal; no public mainnet transaction', 'Pool donor was impersonated only inside Anvil', 'No eligibility, legal, independent security, physical-device, or production-operations approval'],
  };
  const output = process.argv.find(value => value.startsWith('--output='))?.slice('--output='.length);
  if (output) await writeFile(output, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ status: evidence.status, checks: checks.length, forkBlock: evidence.fork.blockNumber, boughtAaplRaw: evidence.measured.boughtAaplRaw, soldAaplRaw: evidence.measured.soldAaplRaw, publicTransactions: false, output: output ?? null }));
} finally {
  proc.kill();
  await proc.exited;
}
