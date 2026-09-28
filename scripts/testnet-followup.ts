/** Reconcile-safe follow-up for the valueless Robinhood Chain testnet account. */
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { createPublicClient, createWalletClient, decodeFunctionData, defineChain, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const rpc = 'https://rpc.testnet.chain.robinhood.com';
const chainId = 46630;
const chain = defineChain({ id: chainId, name: 'Robinhood Chain Testnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
function assert(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
const input = process.argv.find(arg => arg.startsWith('--state-dir='))?.slice('--state-dir='.length);
assert(input, 'Use --state-dir=/path/to/private/testnet-state');
const stateDir = resolve(input);
const pathFromRepo = relative(process.cwd(), stateDir);
assert(pathFromRepo.startsWith('..') || isAbsolute(pathFromRepo), 'Private state must stay outside the repository');
const keyPath = `${stateDir}/deployer.key`;
const keyStat = statSync(keyPath);
assert(keyStat.isFile() && (keyStat.mode & 0o077) === 0, 'Testnet key must be a 0600 file');
const parent = privateKeyToAccount(readFileSync(keyPath, 'utf8').trim() as Hex);
const recordPath = `${stateDir}/account-rehearsal.json`;
const record = JSON.parse(readFileSync(recordPath, 'utf8'));
assert(record.chainId === chainId && record.parent.toLowerCase() === parent.address.toLowerCase(), 'Wrong chain or parent');
assert(record.status === 'verified_initial_rehearsal' || record.status === 'verified_followup', 'Initial rehearsal was not verified');
const account = record.account as Address;
const token = record.mockSettlement as Address;
const client = createPublicClient({ chain, transport: http(rpc) });
const wallet = createWalletClient({ account: parent, chain, transport: http(rpc) });
assert(await client.getChainId() === chainId, 'RPC is not Robinhood testnet');
const accountAbi = JSON.parse(readFileSync('contracts/out/StewardAccountV1.sol/StewardAccountV1.json', 'utf8')).abi;
const tokenAbi = JSON.parse(readFileSync('contracts/out/MockStewardToken.sol/MockStewardToken.json', 'utf8')).abi;
assert((await client.readContract({ address: account, abi: accountAbi, functionName: 'parent' } as any) as Address).toLowerCase() === parent.address.toLowerCase(), 'Account parent changed');
const paymentStep = record.steps.find((step: any) => step.label === 'execute_bounded_payment');
assert(paymentStep?.status === 'confirmed', 'Prior payment is not confirmed');
const paymentTx = await client.getTransaction({ hash: paymentStep.transactionHash as Hex });
const payment = decodeFunctionData({ abi: accountAbi, data: paymentTx.input });
assert(payment.functionName === 'executePayment', 'Prior payment calldata mismatch');
const priorAction = (payment.args as any)[0];
assert(await client.readContract({ address: account, abi: accountAbi, functionName: 'executedAction', args: [priorAction.actionId] } as any), 'Prior action is not marked executed');
let replayRejected = record.followup?.replayRejectedAlreadyUsed === true;
if ((await client.getBlock()).timestamp <= BigInt(priorAction.deadline)) {
  replayRejected = false;
  try {
    await client.simulateContract({ address: account, abi: accountAbi, functionName: 'executePayment', args: payment.args as any, account: parent.address });
  } catch (error) { replayRejected = String(error).includes('AlreadyUsed'); }
}
assert(replayRejected, 'Prior payment replay evidence is missing or failed');
const withdrawalAmount = 25_000_000n;
let outsiderRejected = false;
try {
  await client.simulateContract({ address: account, abi: accountAbi, functionName: 'withdraw', args: [token, withdrawalAmount, parent.address], account: record.roles.caregiver as Address });
} catch (error) { outsiderRejected = String(error).includes('Unauthorized'); }
assert(outsiderRejected, 'Non-parent withdrawal did not revert with Unauthorized');
record.followup ??= {};
record.followup.replayRejectedAlreadyUsed = replayRejected;
record.followup.nonParentWithdrawRejectedUnauthorized = outsiderRejected;
const save = () => writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
save();
let withdrawal = record.steps.find((step: any) => step.label === 'parent_emergency_withdrawal');
if (!withdrawal) {
  const beforeParent = await client.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [parent.address] } as any) as bigint;
  const beforeAccount = await client.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [account] } as any) as bigint;
  await client.simulateContract({ address: account, abi: accountAbi, functionName: 'withdraw', args: [token, withdrawalAmount, parent.address], account: parent.address });
  const hash = await wallet.writeContract({ address: account, abi: accountAbi, functionName: 'withdraw', args: [token, withdrawalAmount, parent.address], account: parent, chain });
  withdrawal = { label: 'parent_emergency_withdrawal', transactionHash: hash, status: 'broadcast', amountRaw: withdrawalAmount.toString(), beforeParentRaw: beforeParent.toString(), beforeAccountRaw: beforeAccount.toString() };
  record.steps.push(withdrawal);
  save();
}
const receipt = await client.waitForTransactionReceipt({ hash: withdrawal.transactionHash as Hex, confirmations: 3, timeout: 120_000 });
assert(receipt.status === 'success', 'Parent withdrawal reverted');
const parentBalance = await client.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [parent.address] } as any) as bigint;
const accountBalance = await client.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [account] } as any) as bigint;
assert(parentBalance >= BigInt(withdrawal.beforeParentRaw) + withdrawalAmount, 'Parent did not receive withdrawn mock tokens');
assert(accountBalance <= BigInt(withdrawal.beforeAccountRaw) - withdrawalAmount, 'Account was not debited');
withdrawal.status = 'confirmed';
withdrawal.blockNumber = receipt.blockNumber.toString();
withdrawal.gasUsed = receipt.gasUsed.toString();
record.followup.parentMockBalanceRaw = parentBalance.toString();
record.followup.accountMockBalanceRaw = accountBalance.toString();
record.status = 'verified_followup';
save();
console.log(JSON.stringify({ chainId, account, replayRejectedAlreadyUsed: replayRejected, nonParentWithdrawRejectedUnauthorized: outsiderRejected, withdrawalTransactionHash: withdrawal.transactionHash, withdrawalBlock: withdrawal.blockNumber, parentMockBalanceRaw: parentBalance.toString(), accountMockBalanceRaw: accountBalance.toString() }));
