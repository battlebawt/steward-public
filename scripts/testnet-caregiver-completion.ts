/** Complete the queued, valueless caregiver test only after its on-chain review delay. */
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { createPublicClient, createWalletClient, decodeEventLog, defineChain, http, keccak256, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ACTION_TYPES, actionDomain, actionMessage, type ActionIntent, ZERO_ADDRESS } from '@steward/shared';

const rpc = 'https://rpc.testnet.chain.robinhood.com';
const chainId = 46630;
const chain = defineChain({ id: chainId, name: 'Robinhood Chain Testnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
function assert(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
const input = process.argv.find(arg => arg.startsWith('--state-dir='))?.slice('--state-dir='.length);
assert(input, 'Use --state-dir=/path/to/private/testnet-state');
const stateDir = resolve(input);
const pathFromRepo = relative(process.cwd(), stateDir);
assert(pathFromRepo.startsWith('..') || isAbsolute(pathFromRepo), 'Private state must stay outside the repository');
const recordPath = `${stateDir}/account-rehearsal.json`;
const record = JSON.parse(readFileSync(recordPath, 'utf8'));
const immediate = JSON.parse(readFileSync(`${stateDir}/immediate-delegate-rehearsal.json`, 'utf8'));
assert(record.chainId === chainId && ['verified_followup', 'verified_caregiver_rehearsal'].includes(record.status), 'Wrong chain or missing prior testnet checks');
const account = record.account as Address;
const token = record.mockSettlement as Address;
const caregiverAddress = record.roles.caregiver as Address;
const client = createPublicClient({ chain, transport: http(rpc) });
assert(await client.getChainId() === chainId, 'RPC is not Robinhood testnet');
const abi = JSON.parse(readFileSync('contracts/out/StewardAccountV1.sol/StewardAccountV1.json', 'utf8')).abi;
const tokenAbi = JSON.parse(readFileSync('contracts/out/MockStewardToken.sol/MockStewardToken.json', 'utf8')).abi;
assert(immediate.chainId === chainId && immediate.status === 'verified_immediate_delegate_rehearsal', 'Missing prior immediate-delegate rehearsal');
assert(immediate.account.toLowerCase() !== account.toLowerCase() && immediate.mockSettlement.toLowerCase() === token.toLowerCase() && immediate.recipient.toLowerCase() === record.roles.recipient.toLowerCase(), 'Prior rehearsal used a different token or recipient');
assert(immediate.intent.account.toLowerCase() === immediate.account.toLowerCase() && immediate.intent.tokenIn.toLowerCase() === token.toLowerCase() && immediate.intent.recipient.toLowerCase() === record.roles.recipient.toLowerCase(), 'Prior payment intent differs');
const immediatePayment = immediate.steps.find((step: any) => step.label === 'caregiver_bounded_payment_same_day');
assert(immediatePayment?.status === 'confirmed', 'Prior mock payment is not recorded as confirmed');
const immediateReceipt = await client.getTransactionReceipt({ hash: immediatePayment.transactionHash as Hex });
assert(immediateReceipt.status === 'success', 'Prior mock payment reverted');
const priorTransfer = immediateReceipt.logs.some(log => {
  if (log.address.toLowerCase() !== token.toLowerCase()) return false;
  try {
    const event = decodeEventLog({ abi: tokenAbi, data: log.data, topics: log.topics });
    const args = event.args as { from?: Address; to?: Address; value?: bigint };
    return event.eventName === 'Transfer' && args.from?.toLowerCase() === immediate.account.toLowerCase()
      && args.to?.toLowerCase() === record.roles.recipient.toLowerCase() && args.value === BigInt(immediate.intent.amountInRaw);
  } catch { return false; }
});
assert(priorTransfer, 'Prior mock payment transfer is missing from the chain');
const recipientBeforeCaregiverRaw = BigInt(immediate.recipientBeforeRaw) + BigInt(immediate.intent.amountInRaw);
const pending = await client.readContract({ address: account, abi, functionName: 'pendingDelegate' } as any) as any;
const grant = await client.readContract({ address: account, abi, functionName: 'delegates', args: [caregiverAddress] } as any) as any;
const latest = await client.getBlock();
const readyAt = BigInt(record.caregiverGrantReadyAt);
if (!grant[4] && latest.timestamp < readyAt) {
  assert(pending[5] && BigInt(pending[4]) === readyAt && pending[0].toLowerCase() === caregiverAddress.toLowerCase(), 'Queued grant changed');
  console.log(JSON.stringify({ status: 'waiting_for_contract_delay', chainId, account, readyAt: new Date(Number(readyAt) * 1000).toISOString(), currentBlockTime: new Date(Number(latest.timestamp) * 1000).toISOString(), broadcasted: false }));
  process.exit(0);
}
for (const keyPath of [`${stateDir}/deployer.key`, `${stateDir}/role-keys.json`]) {
  const file = statSync(keyPath);
  assert(file.isFile() && (file.mode & 0o077) === 0, 'Role keys must be 0600 files');
}
const parent = privateKeyToAccount(readFileSync(`${stateDir}/deployer.key`, 'utf8').trim() as Hex);
const roles = JSON.parse(readFileSync(`${stateDir}/role-keys.json`, 'utf8'));
const caregiver = privateKeyToAccount(roles.caregiver as Hex);
assert(parent.address.toLowerCase() === record.parent.toLowerCase() && caregiver.address.toLowerCase() === caregiverAddress.toLowerCase(), 'Testnet role key mismatch');
assert((await client.readContract({ address: account, abi, functionName: 'parent' } as any) as Address).toLowerCase() === parent.address.toLowerCase(), 'On-chain parent changed');
const wallet = createWalletClient({ account: parent, chain, transport: http(rpc) });
const save = () => writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
async function confirm(label: string, hash: Hex) {
  const step = record.steps.find((value: any) => value.label === label);
  assert(step?.transactionHash.toLowerCase() === hash.toLowerCase(), 'Recorded transaction changed');
  const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 3, timeout: 120_000 });
  assert(receipt.status === 'success', `${label} reverted`);
  step.status = 'confirmed';
  step.blockNumber = receipt.blockNumber.toString();
  step.gasUsed = receipt.gasUsed.toString();
  save();
}
let activation = record.steps.find((step: any) => step.label === 'activate_caregiver_grant');
if (!activation) {
  assert(!grant[4] && pending[5] && BigInt(pending[4]) === readyAt && pending[0].toLowerCase() === caregiverAddress.toLowerCase(), 'Grant was changed or activated outside this rehearsal');
  await client.simulateContract({ address: account, abi, functionName: 'executeDelegateExpansion', account: parent.address });
  const hash = await wallet.writeContract({ address: account, abi, functionName: 'executeDelegateExpansion', account: parent, chain });
  activation = { label: 'activate_caregiver_grant', transactionHash: hash, status: 'broadcast' };
  record.steps.push(activation);
  save();
}
await confirm('activate_caregiver_grant', activation.transactionHash as Hex);
const active = await client.readContract({ address: account, abi, functionName: 'delegates', args: [caregiverAddress] } as any) as any;
assert(active[4] && active[0] === 1n && active[1] === 50_000_000n, 'Caregiver grant differs from reviewed scope');
const version = (await client.readContract({ address: account, abi, functionName: 'policy' } as any) as readonly bigint[])[10]!;
const epoch = await client.readContract({ address: account, abi, functionName: 'securityEpoch' } as any) as bigint;
const actionId = keccak256(toHex('steward-testnet-caregiver-payment-2026-09-22'));
let payment = record.steps.find((step: any) => step.label === 'caregiver_signed_bounded_payment');
if (!payment) {
  assert(!(await client.readContract({ address: account, abi, functionName: 'executedAction', args: [actionId] } as any)), 'Payment executed without a recorded transaction; reconcile first');
  const recipientBalance = await client.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [record.roles.recipient] } as any) as bigint;
  assert(recipientBalance === recipientBeforeCaregiverRaw, 'Recipient balance changed outside recorded rehearsals');
  const now = (await client.getBlock()).timestamp;
  const intent: ActionIntent = {
    actionId, kind: 'PAYMENT', account, actor: caregiver.address, chainId, securityEpoch: epoch.toString(), policyVersion: version.toString(), nonce: '1',
    tokenIn: token, tokenOut: ZERO_ADDRESS, recipient: record.roles.recipient,
    amountInRaw: '5000000', minAmountOutRaw: '0', adapter: ZERO_ADDRESS, routeHash: `0x${'00'.repeat(32)}` as Hex,
    validAfter: String(now - 1n), deadline: String(now + 3600n), exceptionMask: '0',
  };
  const signature = await caregiver.signTypedData({ domain: actionDomain(intent), types: ACTION_TYPES, primaryType: 'Action', message: actionMessage(intent) });
  await client.simulateContract({ address: account, abi, functionName: 'executePayment', args: [actionMessage(intent), [signature]], account: parent.address });
  const hash = await wallet.writeContract({ address: account, abi, functionName: 'executePayment', args: [actionMessage(intent), [signature]], account: parent, chain });
  payment = { label: 'caregiver_signed_bounded_payment', transactionHash: hash, status: 'broadcast', actionId, amountRaw: '5000000' };
  record.steps.push(payment);
  save();
}
await confirm('caregiver_signed_bounded_payment', payment.transactionHash as Hex);
const recipientBalance = await client.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [record.roles.recipient] } as any) as bigint;
assert(recipientBalance === recipientBeforeCaregiverRaw + 5_000_000n, 'Recipient did not receive exact caregiver payment');
record.status = 'verified_caregiver_rehearsal';
record.caregiverRecipientBalanceRaw = recipientBalance.toString();
save();
console.log(JSON.stringify({ status: record.status, chainId, account, caregiver: caregiver.address, activationTransactionHash: activation.transactionHash, paymentTransactionHash: payment.transactionHash, recipientBalanceRaw: recipientBalance.toString() }));
