/** Mock-only Robinhood testnet proof that a parent can grant a caregiver immediately. */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { createPublicClient, createWalletClient, decodeEventLog, defineChain, encodeFunctionData, http, keccak256, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ACTION_TYPES, actionDomain, actionMessage, type ActionIntent, ZERO_ADDRESS } from '@steward/shared';
import { buildPlan } from './deployment-plan';

const rpc = 'https://rpc.testnet.chain.robinhood.com';
const chainId = 46630;
const chain = defineChain({ id: chainId, name: 'Robinhood Chain Testnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
function assert(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
function privateFile(path: string) { const file = statSync(path); assert(file.isFile() && (file.mode & 0o077) === 0, `${path} must be a 0600 file`); }
function maskImmutables(code: Hex, references: Record<string, { start: number; length: number }[]>): string {
  let masked = code.toLowerCase();
  for (const slots of Object.values(references)) for (const { start, length } of slots) {
    const offset = 2 + start * 2;
    assert(offset + length * 2 <= masked.length, 'Immutable slot exceeds mock token bytecode');
    masked = masked.slice(0, offset) + '00'.repeat(length) + masked.slice(offset + length * 2);
  }
  return masked;
}
const input = process.argv.find(arg => arg.startsWith('--state-dir='))?.slice('--state-dir='.length);
assert(input, 'Use --state-dir=/private/testnet-state');
const stateDir = resolve(input);
const pathFromRepo = relative(process.cwd(), stateDir);
assert(pathFromRepo.startsWith('..') || isAbsolute(pathFromRepo), 'Private state must stay outside the repository');
const keyPath = `${stateDir}/deployer.key`;
const rolesPath = `${stateDir}/role-keys.json`;
const factoryPath = `${stateDir}/factory-immediate-delegates.json`;
const initialPath = `${stateDir}/account-rehearsal.json`;
const recordPath = `${stateDir}/immediate-delegate-rehearsal.json`;
for (const path of [keyPath, rolesPath, factoryPath, initialPath]) privateFile(path);
const parent = privateKeyToAccount(readFileSync(keyPath, 'utf8').trim() as Hex);
const roles = JSON.parse(readFileSync(rolesPath, 'utf8'));
const initial = JSON.parse(readFileSync(initialPath, 'utf8'));
const deployed = JSON.parse(readFileSync(factoryPath, 'utf8'));
assert(initial.chainId === chainId && deployed.chainId === chainId && deployed.status === 'verified', 'Wrong testnet fixture or unverified factory');
assert(initial.parent.toLowerCase() === parent.address.toLowerCase() && deployed.deployer.toLowerCase() === parent.address.toLowerCase(), 'Testnet parent key mismatch');
const caregiver = privateKeyToAccount(roles.caregiver as Hex);
assert(caregiver.address.toLowerCase() === initial.roles.caregiver.toLowerCase(), 'Caregiver fixture key mismatch');
const recipient = initial.roles.recipient as Address;
const token = initial.mockSettlement as Address;
const client = createPublicClient({ chain, transport: http(rpc) });
const wallet = createWalletClient({ account: parent, chain, transport: http(rpc) });
assert(await client.getChainId() === chainId, 'RPC is not Robinhood testnet');
const freshPlan = await buildPlan({ chainId, contract: 'factory', deployer: parent.address, nonce: deployed.nonce });
assert(freshPlan.artifactSha256 === deployed.artifactSha256 && freshPlan.sourceManifestSha256 === deployed.sourceManifestSha256 && freshPlan.predictedCreateAddress.toLowerCase() === deployed.factory.toLowerCase(), 'Factory no longer matches reviewed sources and artifacts');
const factory = deployed.factory as Address;
const implementation = deployed.implementation as Address;
const factoryCode = await client.getCode({ address: factory });
const implementationCode = await client.getCode({ address: implementation });
assert(factoryCode && implementationCode && keccak256(factoryCode) === deployed.factoryRuntimeKeccak256 && keccak256(implementationCode) === deployed.implementationRuntimeKeccak256, 'Factory or implementation code pin changed');
const factoryAbi = JSON.parse(readFileSync('contracts/out/StewardFactoryV1.sol/StewardFactoryV1.json', 'utf8')).abi;
const accountAbi = JSON.parse(readFileSync('contracts/out/StewardAccountV1.sol/StewardAccountV1.json', 'utf8')).abi;
const mockArtifact = JSON.parse(readFileSync('contracts/out/MockStewardToken.sol/MockStewardToken.json', 'utf8'));
const tokenCode = await client.getCode({ address: token });
assert(tokenCode && tokenCode.length === mockArtifact.deployedBytecode.object.length &&
  maskImmutables(tokenCode, mockArtifact.deployedBytecode.immutableReferences ?? {}) ===
    maskImmutables(mockArtifact.deployedBytecode.object, mockArtifact.deployedBytecode.immutableReferences ?? {}),
  'Settlement is not the reviewed public-mint mock');
assert(await client.readContract({ address: token, abi: mockArtifact.abi, functionName: 'decimals' } as any) === 6, 'Mock settlement has unexpected decimals');
const manifest = await client.readContract({ address: factory, abi: factoryAbi, functionName: 'MANIFEST' } as any) as Hex;
assert(manifest === keccak256(toHex('STEWARD_ACCOUNT_V1_MANIFEST_2026-09-23_IMMEDIATE_DELEGATES')), 'Factory has the wrong delegate-grant semantics');
if (process.argv.includes('--dry-run')) {
  console.log(JSON.stringify({ status: 'preflight_only', chainId, parent: parent.address, caregiver: caregiver.address, factory, implementation, mockSettlement: token, broadcasted: false }));
  process.exit(0);
}

type Step = { label: string; to: Address; callHash: Hex; nonce: number; status: 'planned' | 'broadcast' | 'confirmed'; transactionHash?: Hex; blockNumber?: string; gasUsed?: string };
const newRecord = { chainId, parent: parent.address, caregiver: caregiver.address, recipient, factory, implementation, mockSettlement: token, factoryArtifactSha256: deployed.artifactSha256, steps: [] as Step[] };
if (!existsSync(recordPath)) writeFileSync(recordPath, JSON.stringify(newRecord, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
privateFile(recordPath);
const record = JSON.parse(readFileSync(recordPath, 'utf8')) as typeof newRecord & { account?: Address; accountRuntimeKeccak256?: Hex; recipientBeforeRaw?: string; intent?: ActionIntent; status?: string };
assert(record.chainId === chainId && record.parent.toLowerCase() === parent.address.toLowerCase() && record.factory.toLowerCase() === factory.toLowerCase() && record.mockSettlement.toLowerCase() === token.toLowerCase(), 'Existing rehearsal record differs from current fixture');
if (record.status === 'verified_immediate_delegate_rehearsal') {
  console.log(JSON.stringify({ status: 'already_verified', chainId, factory, account: record.account, transactions: record.steps.map(({ label, transactionHash }) => ({ label, transactionHash })), broadcasted: false }));
  process.exit(0);
}
const save = () => writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });

async function send(label: string, to: Address, abi: any, functionName: string, args: unknown[]) {
  const data = encodeFunctionData({ abi, functionName, args } as any);
  const callHash = keccak256(data);
  let step = record.steps.find(value => value.label === label);
  const createdNow = !step;
  if (!step) {
    await client.call({ account: parent.address, to, data });
    const nonce = await client.getTransactionCount({ address: parent.address, blockTag: 'pending' });
    step = { label, to, callHash, nonce, status: 'planned' };
    record.steps.push(step);
    save();
  }
  assert(step.to.toLowerCase() === to.toLowerCase() && step.callHash === callHash, `${label} call differs from recorded plan`);
  if (step.status === 'planned') {
    assert(createdNow, `${label} has an uncertain broadcast; reconcile nonce ${step.nonce} before retrying`);
    const gasEstimate = await client.estimateGas({ account: parent.address, to, data });
    const gas = gasEstimate * 12n / 10n;
    const gasPrice = await client.getGasPrice();
    assert((await client.getBalance({ address: parent.address })) > gas * gasPrice * 2n, 'Insufficient test ETH gas buffer');
    const hash = await wallet.sendTransaction({ account: parent, chain, to, data, value: 0n, gas, nonce: step.nonce } as any);
    step.transactionHash = hash;
    step.status = 'broadcast';
    save();
  }
  assert(step.transactionHash, `${label} has no recorded transaction hash`);
  const receipt = await client.waitForTransactionReceipt({ hash: step.transactionHash, confirmations: 3, timeout: 120_000 });
  assert(receipt.status === 'success' && receipt.to?.toLowerCase() === to.toLowerCase(), `${label} receipt failed or target changed`);
  step.status = 'confirmed';
  step.blockNumber = receipt.blockNumber.toString();
  step.gasUsed = receipt.gasUsed.toString();
  save();
  return receipt;
}

const config = {
  settlement: token, period: 86_400n, anchor: 0n, paymentLimit: 100_000_000n, buyLimit: 0n, reserve: 0n,
  perPayment: 20_000_000n, perBuy: 0n, perSell: 0n, exceptionQuorum: 2n, approvedTokens: [], paymentRecipients: [recipient],
  exceptionSigners: [initial.roles.exception1, initial.roles.exception2], guardians: [initial.roles.guardian1, initial.roles.guardian2, initial.roles.guardian3],
  approvedAdapters: [], sellCapTokens: [], sellCaps: [], continuityReviewer: ZERO_ADDRESS, continuitySuccessor: ZERO_ADDRESS, continuityPlanHash: `0x${'00'.repeat(32)}` as Hex,
};
const created = await send('create_immediate_delegate_account', factory, factoryAbi, 'createAccount', [parent.address, config]);
const createdEvent = created.logs.map(log => { try { return decodeEventLog({ abi: factoryAbi, data: log.data, topics: (log as any).topics }) as any; } catch { return null; } }).find(event => event?.eventName === 'AccountCreated' && event.args.manifest === manifest);
assert(createdEvent?.args.parent.toLowerCase() === parent.address.toLowerCase(), 'Factory account event missing or parent changed');
const account = createdEvent.args.account as Address;
assert(!record.account || record.account.toLowerCase() === account.toLowerCase(), 'Recorded account differs from receipt');
record.account = account;
const cloneCode = await client.getCode({ address: account, blockNumber: created.blockNumber });
assert(cloneCode && cloneCode.toLowerCase() === `0x363d3d373d3d3d363d73${implementation.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`, 'Account is not the reviewed immutable implementation clone');
record.accountRuntimeKeccak256 = keccak256(cloneCode);
save();
await send('fund_immediate_account_mock', token, mockArtifact.abi, 'mint', [account, 100_000_000n]);
assert(await client.readContract({ address: token, abi: mockArtifact.abi, functionName: 'balanceOf', args: [account] } as any) === 100_000_000n || record.status === 'verified_immediate_delegate_rehearsal', 'Mock funding mismatch');
const expiry = (await client.getBlock()).timestamp + 30n * 86_400n;
// Keep the original expiry across a restart; a planned call must not change.
const grantExpiry = BigInt((record as any).grantExpiry ?? expiry.toString());
(record as any).grantExpiry = grantExpiry.toString(); save();
await send('grant_caregiver_immediately', account, accountAbi, 'setDelegate', [caregiver.address, 1n, grantExpiry, 10_000_000n]);
const grant = await client.readContract({ address: account, abi: accountAbi, functionName: 'delegates', args: [caregiver.address] } as any) as readonly [bigint, bigint, bigint, bigint, boolean];
const pending = await client.readContract({ address: account, abi: accountAbi, functionName: 'pendingDelegate' } as any) as readonly unknown[];
assert(grant[0] === 1n && grant[1] === 10_000_000n && grant[3] === 1n && grant[4] === true && pending[5] === false, 'Caregiver did not become active in the grant transaction');
const version = (await client.readContract({ address: account, abi: accountAbi, functionName: 'policy' } as any) as readonly bigint[])[10]!;
assert(version === 2n, 'Immediate caregiver grant did not advance policy version');
let unauthorizedRejected = false;
try { await client.simulateContract({ address: account, abi: accountAbi, functionName: 'setDelegate', args: [recipient, 1n, grantExpiry, 1n], account: caregiver.address }); }
catch (error) { unauthorizedRejected = String(error).includes('Unauthorized'); }
assert(unauthorizedRejected, 'Caregiver could change delegation without parent approval');

if (!record.intent) {
  const now = (await client.getBlock()).timestamp;
  record.recipientBeforeRaw = (await client.readContract({ address: token, abi: mockArtifact.abi, functionName: 'balanceOf', args: [recipient] } as any) as bigint).toString();
  record.intent = { actionId: keccak256(toHex('steward-immediate-caregiver-payment-2026-09-23')), kind: 'PAYMENT', account, actor: caregiver.address, chainId,
    securityEpoch: '1', policyVersion: version.toString(), nonce: '1', tokenIn: token, tokenOut: ZERO_ADDRESS, recipient,
    amountInRaw: '5000000', minAmountOutRaw: '0', adapter: ZERO_ADDRESS, routeHash: `0x${'00'.repeat(32)}`,
    validAfter: String(now - 1n), deadline: String(now + 3600n), exceptionMask: '0' };
  save();
}
assert(record.intent.account.toLowerCase() === account.toLowerCase() && record.intent.actor.toLowerCase() === caregiver.address.toLowerCase(), 'Recorded action differs from account or caregiver');
const signature = await caregiver.signTypedData({ domain: actionDomain(record.intent), types: ACTION_TYPES, primaryType: 'Action', message: actionMessage(record.intent) });
await send('caregiver_bounded_payment_same_day', account, accountAbi, 'executePayment', [actionMessage(record.intent), [signature]]);
const recipientAfter = await client.readContract({ address: token, abi: mockArtifact.abi, functionName: 'balanceOf', args: [recipient] } as any) as bigint;
assert(recipientAfter === BigInt(record.recipientBeforeRaw!) + 5_000_000n, 'Caregiver payment did not reach approved recipient exactly');
let replayRejected = false;
try { await client.simulateContract({ address: account, abi: accountAbi, functionName: 'executePayment', args: [actionMessage(record.intent), [signature]], account: parent.address }); }
catch (error) { replayRejected = String(error).includes('AlreadyUsed'); }
assert(replayRejected, 'Caregiver action replay was accepted');
const overCap: ActionIntent = { ...record.intent, actionId: keccak256(toHex('steward-immediate-caregiver-over-cap-2026-09-23')), nonce: '2', amountInRaw: '11000000' };
const overCapSignature = await caregiver.signTypedData({ domain: actionDomain(overCap), types: ACTION_TYPES, primaryType: 'Action', message: actionMessage(overCap) });
let capRejected = false;
try { await client.simulateContract({ address: account, abi: accountAbi, functionName: 'executePayment', args: [actionMessage(overCap), [overCapSignature]], account: parent.address }); }
catch (error) { capRejected = String(error).includes('CapExceeded'); }
assert(capRejected, 'Caregiver per-action cap was bypassed');
record.status = 'verified_immediate_delegate_rehearsal';
save();
console.log(JSON.stringify({ status: record.status, chainId, factory, implementation, account, caregiver: caregiver.address, mockSettlement: token,
  grantActiveImmediately: true, unauthorizedGrantRejected: true, replayRejected, capRejected, recipientBeforeRaw: record.recipientBeforeRaw,
  recipientAfterRaw: recipientAfter.toString(), transactions: record.steps.map(({ label, transactionHash }) => ({ label, transactionHash })), realFunds: false }));
