/** Public Robinhood testnet fixture: mock settlement, guarded account, payment, and delayed caregiver grant. */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { createPublicClient, createWalletClient, decodeEventLog, defineChain, http, keccak256, toHex, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ACTION_TYPES, actionDomain, actionMessage, type ActionIntent, ZERO_ADDRESS } from '@steward/shared';

const RPC = 'https://rpc.testnet.chain.robinhood.com';
const CHAIN_ID = 46630;
const chain = defineChain({ id: CHAIN_ID, name: 'Robinhood Chain Testnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const stateDirInput = process.argv.find((part) => part.startsWith('--state-dir='))?.slice('--state-dir='.length);
assert(stateDirInput, 'Use --state-dir=/path/to/private/testnet-state');
const stateDir = resolve(stateDirInput);
const outsideRepo = relative(process.cwd(), stateDir);
assert(outsideRepo.startsWith('..') || isAbsolute(outsideRepo), 'Private testnet state must be outside the repository');
const accountKeyPath = `${stateDir}/deployer.key`;
const roleKeysPath = `${stateDir}/role-keys.json`;
const recordPath = `${stateDir}/account-rehearsal.json`;
const factoryDeployment = JSON.parse(readFileSync(`${stateDir}/factory-deployment.json`, 'utf8'));
assert(factoryDeployment.chainId === CHAIN_ID && factoryDeployment.status === 'verified', 'Factory deployment record is not verified testnet evidence');
const factory = factoryDeployment.factory as Address;
const privateFile = (path: string) => {
  const stats = statSync(path);
  assert(stats.isFile() && (stats.mode & 0o077) === 0, `${path} must have 0600 permissions`);
};
privateFile(accountKeyPath);
const parent = privateKeyToAccount(readFileSync(accountKeyPath, 'utf8').trim() as Hex);
assert(parent.address.toLowerCase() === factoryDeployment.deployer.toLowerCase(), 'Wrong testnet key');
assert(!existsSync(recordPath), 'Rehearsal record already exists; reconcile transactions instead of rerunning');
const client = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ account: parent, chain, transport: http(RPC) });
assert(await client.getChainId() === CHAIN_ID, 'RPC is not Robinhood testnet');
assert((await client.getBytecode({ address: factory })) !== undefined, 'Reviewed testnet factory is missing');
const mock = JSON.parse(readFileSync('contracts/out/MockStewardToken.sol/MockStewardToken.json', 'utf8'));
const factoryArtifact = JSON.parse(readFileSync('contracts/out/StewardFactoryV1.sol/StewardFactoryV1.json', 'utf8'));
const accountArtifact = JSON.parse(readFileSync('contracts/out/StewardAccountV1.sol/StewardAccountV1.json', 'utf8'));

type Roles = { caregiver: Hex; exception1: Hex; exception2: Hex; guardian1: Hex; guardian2: Hex; guardian3: Hex; recipient: Hex };
if (!existsSync(roleKeysPath)) {
  const roles: Roles = {
    caregiver: generatePrivateKey(), exception1: generatePrivateKey(), exception2: generatePrivateKey(),
    guardian1: generatePrivateKey(), guardian2: generatePrivateKey(), guardian3: generatePrivateKey(),
    recipient: generatePrivateKey(),
  };
  writeFileSync(roleKeysPath, JSON.stringify(roles, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
privateFile(roleKeysPath);
const roleKeys = JSON.parse(readFileSync(roleKeysPath, 'utf8')) as Roles;
const roleAddresses = Object.fromEntries(Object.entries(roleKeys).map(([name, key]) => [name, privateKeyToAccount(key).address])) as Record<keyof Roles, Address>;
const state: Record<string, unknown> = { network: 'Robinhood Chain Testnet', chainId: CHAIN_ID, parent: parent.address, factory, roles: roleAddresses, steps: [] as unknown[] };
const save = () => writeFileSync(recordPath, JSON.stringify(state, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n', { mode: 0o600 });
save();
async function mined(label: string, hash: Hex) {
  const steps = state.steps as Record<string, unknown>[];
  const step: Record<string, unknown> = { label, transactionHash: hash, status: 'broadcast' };
  steps.push(step);
  save();
  const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 3, timeout: 120_000 });
  assert(receipt.status === 'success', `${label} reverted`);
  step.status = 'confirmed';
  step.blockNumber = receipt.blockNumber.toString();
  step.gasUsed = receipt.gasUsed.toString();
  save();
  return receipt;
}

const tokenReceipt = await mined('deploy_public_mint_mock_settlement', await wallet.deployContract({ abi: mock.abi, bytecode: mock.bytecode.object, args: ['Steward Test Settlement', 'STEST', 6], account: parent, chain } as any));
const token = tokenReceipt.contractAddress;
assert(token, 'Mock token deployment has no address');
state.mockSettlement = token;
save();
const config = {
  settlement: token, period: 86_400n, anchor: 0n, paymentLimit: 500_000_000n,
  buyLimit: 0n, reserve: 0n, perPayment: 100_000_000n, perBuy: 0n, perSell: 0n,
  exceptionQuorum: 2n, approvedTokens: [], paymentRecipients: [roleAddresses.recipient],
  exceptionSigners: [roleAddresses.exception1, roleAddresses.exception2],
  guardians: [roleAddresses.guardian1, roleAddresses.guardian2, roleAddresses.guardian3],
  approvedAdapters: [], sellCapTokens: [], sellCaps: [],
  continuityReviewer: ZERO_ADDRESS, continuitySuccessor: ZERO_ADDRESS,
  continuityPlanHash: `0x${'00'.repeat(32)}` as Hex,
};
const created = await mined('create_guarded_account', await wallet.writeContract({ address: factory, abi: factoryArtifact.abi, functionName: 'createAccount', args: [parent.address, config], account: parent, chain }));
const event = created.logs.map((log) => { try { return decodeEventLog({ abi: factoryArtifact.abi, data: log.data, topics: (log as any).topics }); } catch { return null; } }).find((value: any) => value?.eventName === 'AccountCreated') as any;
const account = event?.args?.account as Address | undefined;
assert(account, 'AccountCreated event missing');
assert((await client.readContract({ address: account, abi: accountArtifact.abi, functionName: 'parent' } as any) as Address).toLowerCase() === parent.address.toLowerCase(), 'Parent on chain differs');
state.account = account;
save();
await mined('fund_mock_settlement', await wallet.writeContract({ address: token, abi: mock.abi, functionName: 'mint', args: [account, 1_000_000_000n], account: parent, chain }));
const now = (await client.getBlock()).timestamp;
const version = (await client.readContract({ address: account, abi: accountArtifact.abi, functionName: 'policy' } as any) as readonly bigint[])[10]!;
const base: ActionIntent = {
  actionId: keccak256(toHex(crypto.getRandomValues(new Uint8Array(32)))), kind: 'PAYMENT', account,
  actor: parent.address, chainId: CHAIN_ID, securityEpoch: '1', policyVersion: version.toString(), nonce: '1',
  tokenIn: token, tokenOut: ZERO_ADDRESS, recipient: roleAddresses.recipient,
  amountInRaw: '50000000', minAmountOutRaw: '0', adapter: ZERO_ADDRESS,
  routeHash: `0x${'00'.repeat(32)}`, validAfter: String(now - 1n), deadline: String(now + 3600n), exceptionMask: '0',
};
const overCap: ActionIntent = { ...base, actionId: keccak256(toHex(crypto.getRandomValues(new Uint8Array(32)))), nonce: '2', amountInRaw: '101000000' };
const overCapSignature = await parent.signTypedData({ domain: actionDomain(overCap), types: ACTION_TYPES, primaryType: 'Action', message: actionMessage(overCap) });
let overCapRejected = false;
try {
  await client.simulateContract({ address: account, abi: accountArtifact.abi, functionName: 'executePayment', args: [actionMessage(overCap), [overCapSignature]], account: parent.address });
} catch (error) {
  overCapRejected = String(error).includes('CapExceeded');
}
assert(overCapRejected, 'Over-cap payment did not revert with CapExceeded');
state.overCapRejected = true;
save();
const signature = await parent.signTypedData({ domain: actionDomain(base), types: ACTION_TYPES, primaryType: 'Action', message: actionMessage(base) });
await mined('execute_bounded_payment', await wallet.writeContract({ address: account, abi: accountArtifact.abi, functionName: 'executePayment', args: [actionMessage(base), [signature]], account: parent, chain }));
const recipientBalance = await client.readContract({ address: token, abi: mock.abi, functionName: 'balanceOf', args: [roleAddresses.recipient] } as any) as bigint;
assert(recipientBalance === 50_000_000n, 'Recipient did not receive exact bounded payment');
state.paymentRecipientBalanceRaw = recipientBalance.toString();
save();
const expiresAt = (await client.getBlock()).timestamp + 30n * 86_400n;
await mined('queue_caregiver_grant', await wallet.writeContract({ address: account, abi: accountArtifact.abi, functionName: 'setDelegate', args: [roleAddresses.caregiver, 1n, expiresAt, 50_000_000n], account: parent, chain }));
const pending = await client.readContract({ address: account, abi: accountArtifact.abi, functionName: 'pendingDelegate' } as any) as any;
const delegate = await client.readContract({ address: account, abi: accountArtifact.abi, functionName: 'delegates', args: [roleAddresses.caregiver] } as any) as any;
assert(pending[5] === true && delegate[4] === false, 'Caregiver grant should be queued, not active');
state.caregiverGrantReadyAt = String(pending[4]);
state.status = 'verified_initial_rehearsal';
save();
console.log(JSON.stringify({ chainId: CHAIN_ID, factory, mockSettlement: token, account, parent: parent.address,
  overCapRejected, recipientBalanceRaw: recipientBalance.toString(), caregiverGrantReadyAt: state.caregiverGrantReadyAt,
  transactions: (state.steps as any[]).map(({ label, transactionHash }) => ({ label, transactionHash })) }));
