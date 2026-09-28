/** Local Anvil only. Ephemeral keys and a mock settlement token; never uses a public RPC. */
import { createPublicClient, createWalletClient, http, keccak256, stringToHex, decodeEventLog, type Address, type Hex } from 'viem';
import { foundry } from 'viem/chains';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { readFile } from 'node:fs/promises';
import { VerifiedLiveChainGateway } from '../server/src/integrations/live-chain';
import { ReadRpcPool } from '../server/src/integrations/rpc';

const artifact = async (name: string) => JSON.parse(await readFile(`contracts/out/${name}.sol/${name}.json`, 'utf8'));
const port = 18000 + Math.floor(Math.random() * 10000);
const processHandle = Bun.spawn(['anvil', '--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337', '--timestamp', String(Math.floor(Date.now() / 1000) - 172800), '--silent'], { stdout: 'pipe', stderr: 'pipe' });
const url = `http://127.0.0.1:${port}`;
const client = createPublicClient({ chain: foundry, transport: http(url) });
const parent = privateKeyToAccount(generatePrivateKey());
const reviewer = privateKeyToAccount(generatePrivateKey());
const caregiver = privateKeyToAccount(generatePrivateKey());
const successor = privateKeyToAccount(generatePrivateKey());
const guardians = [privateKeyToAccount(generatePrivateKey()), privateKeyToAccount(generatePrivateKey()), privateKeyToAccount(generatePrivateKey())];
const exceptions = [privateKeyToAccount(generatePrivateKey()), privateKeyToAccount(generatePrivateKey())];
const addresses = (accounts: Array<{ address: Address }>) => accounts.map((account) => account.address);
const walletFor = (account: ReturnType<typeof privateKeyToAccount>) => createWalletClient({ account, chain: foundry, transport: http(url) });
const wallet = walletFor(parent);
let checks = 0;
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); checks++; };
const rejected = async (operation: () => Promise<unknown>, message: string) => { let failed = false; try { await operation(); } catch { failed = true; } check(failed, message); };
const gatewayRejected = async (operation: () => Promise<unknown>, message: string) => { let mapped = false; try { await operation(); } catch (error) { mapped = String(error).includes('RPC_UNAVAILABLE'); } check(mapped, `${message} (gateway did not return its semantic RPC_UNAVAILABLE mapping)`); };
async function rpc(method: string, params: unknown[]) { const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); const body = await response.json() as any; if (body.error) throw Error(body.error.message); return body.result; }
async function mined(hash: Hex) { const receipt = await client.waitForTransactionReceipt({ hash }); check(receipt.status === 'success', 'transaction reverted'); return receipt; }
async function deploy(name: string, args: unknown[] = []) { const a = await artifact(name); const result = await mined(await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args })); return { abi: a.abi, address: result.contractAddress! as Address }; }
async function finalize() { await rpc('anvil_mine', ['0x40', '0x0']); }
async function send(account: ReturnType<typeof privateKeyToAccount>, contract: { abi: readonly unknown[]; address: Address }, functionName: string, args: unknown[]) { return mined(await walletFor(account).writeContract({ ...contract, functionName, args } as any)); }

try {
  let ready = false;
  for (let i = 0; i < 50; i++) { try { if (processHandle.exitCode !== null) throw new Error('Owned Anvil exited'); if (await client.getChainId() === 31337) { ready = true; break; } } catch {} await Bun.sleep(100); }
  if (!ready) throw new Error('Local Anvil did not start');
  for (const account of [parent, reviewer, caregiver, successor, ...guardians, ...exceptions]) await rpc('anvil_setBalance', [account.address, '0x3635c9adc5dea00000']);

  const token = await deploy('MockStewardToken', ['Continuity settlement', 'USDG', 6]);
  const planHash = keccak256(stringToHex('PLAN-V1'));
  const config = {
    settlement: token.address, period: 86400n, anchor: 0n, paymentLimit: 100_000_000n, buyLimit: 100_000_000n, reserve: 0n,
    perPayment: 20_000_000n, perBuy: 20_000_000n, perSell: 20n * 10n ** 18n, exceptionQuorum: 2n, approvedTokens: [], paymentRecipients: [],
    exceptionSigners: addresses(exceptions), guardians: addresses(guardians), approvedAdapters: [], sellCapTokens: [], sellCaps: [],
    continuityReviewer: reviewer.address, continuitySuccessor: successor.address, continuityPlanHash: planHash,
  };
  const factory = await deploy('StewardFactoryV1');
  const created = await send(parent, factory, 'createAccount', [parent.address, config]);
  const createdEvent = created.logs.map(log => { try { return decodeEventLog({ abi: factory.abi, data: log.data, topics: log.topics }) as any; } catch { return null; } }).find(event => event?.eventName === 'AccountCreated');
  check(Boolean(createdEvent), 'factory account creation event missing');
  const implementation = await client.readContract({ ...factory, functionName: 'implementation' }) as Address;
  const account = { address: createdEvent.args.account as Address, abi: (await artifact('StewardAccountV1')).abi };
  const accountCode = await client.getCode({ address: account.address });
  check(Boolean(accountCode && accountCode !== '0x'), 'account runtime code missing');

  const modulePlanHash = keccak256(stringToHex('INCAPACITY-PLAN-V1'));
  const module = await deploy('StewardIncapacityModuleV1', [account.address, caregiver.address, reviewer.address, addresses(guardians), 2n, 1n, 10_000_000n, modulePlanHash, 86400n, 7n * 86400n]);
  await send(parent, account, 'queueIncapacityModule', [module.address, caregiver.address, 1n, 10_000_000n]);
  await rpc('evm_increaseTime', [172801]); await rpc('evm_mine', []);
  await send(parent, account, 'executeIncapacityModule', []);
  check((await client.readContract({ ...account, functionName: 'incapacityModule' }) as Address).toLowerCase() === module.address.toLowerCase(), 'incapacity module enrollment missing');

  let rpcOffset = 0;
  const gateway = new VerifiedLiveChainGateway({
    rpc: new ReadRpcPool([url], 31337, fetch, () => Date.now() + rpcOffset),
    manifest: { chainId: 31337, version: 'steward-account-v1', accounts: [{ address: account.address, runtimeCodeHash: keccak256(accountCode!), settlement: token.address, deploymentBlock: created.blockNumber.toString(), implementation, implementationCodeHash: keccak256((await client.getCode({ address: implementation }))!) }], routes: [], incapacityModules: [{ account: account.address, address: module.address, runtimeCodeHash: keccak256((await client.getCode({ address: module.address }))!) }], factory: { address: factory.address, runtimeCodeHash: keccak256((await client.getCode({ address: factory.address }))!), implementation, implementationCodeHash: keccak256((await client.getCode({ address: implementation }))!) } },
  });
  check((await gateway.getAccountAuthority(account.address)).securityEpoch === '1', 'initial continuity epoch mismatch');

  // Incapacity: guardian request, reviewer attestation, guardian challenge/resolve, delayed execution.
  let now = Number((await client.getBlock()).timestamp);
  const incapacityDeadline = now + 10 * 86400;
  const incapacityEvidence = keccak256(stringToHex('INCAPACITY-EVIDENCE-1'));
  const incapacityRequest = await gateway.prepareContinuity(account.address, guardians[0].address, { operation: 'requestIncapacity', evidenceHash: incapacityEvidence, deadline: String(incapacityDeadline) });
  const incapacityRequestReceipt = await mined(await walletFor(guardians[0]).sendTransaction({ to: incapacityRequest.to, data: incapacityRequest.data as Hex }));
  const incapacityId = await client.readContract({ ...module, functionName: 'caseNonce' }) as bigint;
  await finalize();
  check(await gateway.confirmContinuityRequest({ type: 'incapacity', account: account.address, chainCaseId: incapacityId.toString(), successor: caregiver.address, transactionHash: incapacityRequestReceipt.transactionHash, evidenceHash: incapacityEvidence, securityEpoch: '1' }), 'incapacity request receipt proof failed');
  const reviewerSig = await reviewer.sign({ hash: await client.readContract({ ...module, functionName: 'reviewHash', args: [incapacityId] }) as Hex });
  const approveIncapacity = { operation: 'approveIncapacity', id: incapacityId.toString(), signature: reviewerSig };
  for (const guardian of guardians.slice(0, 2)) {
    const prepared = await gateway.prepareContinuity(account.address, guardian.address, approveIncapacity);
    await mined(await walletFor(guardian).sendTransaction({ to: prepared.to, data: prepared.data as Hex }));
  }
  let prepared = await gateway.prepareContinuity(account.address, guardians[2].address, { operation: 'challengeIncapacity', id: incapacityId.toString() });
  await mined(await walletFor(guardians[2]).sendTransaction({ to: prepared.to, data: prepared.data as Hex }));
  prepared = await gateway.prepareContinuity(account.address, reviewer.address, { operation: 'resolveIncapacity', id: incapacityId.toString(), approved: true });
  await mined(await walletFor(reviewer).sendTransaction({ to: prepared.to, data: prepared.data as Hex }));
  await rpc('evm_increaseTime', [86401]); await rpc('evm_mine', []); rpcOffset += 86401000;
  prepared = await gateway.prepareContinuity(account.address, guardians[0].address, { operation: 'executeIncapacity', id: incapacityId.toString() });
  const incapacityExecutionReceipt = await mined(await walletFor(guardians[0]).sendTransaction({ to: prepared.to, data: prepared.data as Hex }));
  await finalize();
  check(await gateway.confirmContinuityExecution({ type: 'incapacity', account: account.address, chainCaseId: incapacityId.toString(), successor: caregiver.address, transactionHash: incapacityExecutionReceipt.transactionHash }), 'incapacity execution receipt proof failed');
  check(await client.readContract({ ...account, functionName: 'incapacityActive' }) === true, 'incapacity did not activate');
  check((await client.readContract({ ...account, functionName: 'delegates', args: [caregiver.address] }) as readonly unknown[])[4] === true, 'incapacity caregiver grant missing');

  // Recovery: two guardians pause delegated authority, then the exact delayed epoch transition executes.
  const recoveryParent = privateKeyToAccount(generatePrivateKey());
  await rpc('anvil_setBalance', [recoveryParent.address, '0x3635c9adc5dea00000']);
  now = Number((await client.getBlock()).timestamp);
  const recoveryRequest = await gateway.prepareContinuity(account.address, guardians[0].address, { operation: 'startRecovery', successor: recoveryParent.address });
  const recoveryRequestReceipt = await mined(await walletFor(guardians[0]).sendTransaction({ to: recoveryRequest.to, data: recoveryRequest.data as Hex }));
  const recoveryId = await client.readContract({ ...account, functionName: 'recoveryNonce' }) as bigint;
  await finalize();
  check(await gateway.confirmContinuityRequest({ type: 'recovery', account: account.address, chainCaseId: recoveryId.toString(), successor: recoveryParent.address, transactionHash: recoveryRequestReceipt.transactionHash, securityEpoch: '1' }), 'recovery request receipt proof failed');
  prepared = await gateway.prepareContinuity(account.address, guardians[1].address, { operation: 'approveRecovery', id: recoveryId.toString() });
  await mined(await walletFor(guardians[1]).sendTransaction({ to: prepared.to, data: prepared.data as Hex }));
  await gatewayRejected(() => gateway.prepareContinuity(account.address, caregiver.address, { operation: 'executeRecovery' }), 'recovery execution was accepted before its delay');
  await rpc('evm_increaseTime', [172801]); await rpc('evm_mine', []); rpcOffset += 172801000;
  prepared = await gateway.prepareContinuity(account.address, guardians[0].address, { operation: 'executeRecovery' });
  const recoveryExecutionReceipt = await mined(await walletFor(guardians[0]).sendTransaction({ to: prepared.to, data: prepared.data as Hex }));
  await finalize();
  check(!(await gateway.confirmContinuityExecution({ type: 'recovery', account: account.address, chainCaseId: recoveryId.toString(), successor: recoveryParent.address, transactionHash: recoveryRequestReceipt.transactionHash })), 'recovery request receipt was accepted as execution');
  check(await gateway.confirmContinuityExecution({ type: 'recovery', account: account.address, chainCaseId: recoveryId.toString(), successor: recoveryParent.address, transactionHash: recoveryExecutionReceipt.transactionHash }), 'recovery execution receipt proof failed');
  check((await gateway.getAccountAuthority(account.address)).securityEpoch === '2', 'recovery did not rotate security epoch');
  check((await client.readContract({ ...account, functionName: 'parent' }) as Address).toLowerCase() === recoveryParent.address.toLowerCase(), 'recovery parent mismatch');
  check(await client.readContract({ ...account, functionName: 'incapacityModule' }) === '0x0000000000000000000000000000000000000000', 'recovery did not revoke incapacity module');
  check(await client.readContract({ ...account, functionName: 'incapacityActive' }) === false, 'recovery left incapacity active');
  check((await client.readContract({ ...account, functionName: 'delegates', args: [caregiver.address] }) as readonly unknown[])[4] === false, 'recovery left caregiver authority enabled');
  const staleDeadline = Number((await client.getBlock()).timestamp) + 86400;
  await rejected(() => gateway.prepareContinuity(account.address, guardians[0].address, { operation: 'requestIncapacity', evidenceHash: keccak256(stringToHex('STALE-MODULE')), deadline: String(staleDeadline) }), 'gateway accepted revoked incapacity module');

  // Succession: exact configured plan/reviewer/successor, reviewer-signed guardian quorum, successor acceptance, challenge window.
  now = Number((await client.getBlock()).timestamp);
  const successionEvidence = keccak256(stringToHex('SUCCESSION-EVIDENCE-1'));
  const successionDeadline = now + 40 * 86400;
  prepared = await gateway.prepareContinuity(account.address, guardians[0].address, { operation: 'requestSuccession', successor: successor.address, reviewer: reviewer.address, planHash, evidenceHash: successionEvidence, deadline: String(successionDeadline) });
  const successionRequestReceipt = await mined(await walletFor(guardians[0]).sendTransaction({ to: prepared.to, data: prepared.data as Hex }));
  const successionId = await client.readContract({ ...account, functionName: 'recoveryNonce' }) as bigint;
  await finalize();
  check(await gateway.confirmContinuityRequest({ type: 'succession', account: account.address, chainCaseId: successionId.toString(), successor: successor.address, transactionHash: successionRequestReceipt.transactionHash, planHash, evidenceHash: successionEvidence, securityEpoch: '2' }), 'succession request receipt proof failed');
  const successionReviewerSig = await reviewer.sign({ hash: await client.readContract({ ...account, functionName: 'successionApprovalHash', args: [successionId] }) as Hex });
  const approveSuccession = { operation: 'approveSuccession', id: successionId.toString(), signature: successionReviewerSig };
  for (const guardian of guardians.slice(0, 2)) {
    prepared = await gateway.prepareContinuity(account.address, guardian.address, approveSuccession);
    await mined(await walletFor(guardian).sendTransaction({ to: prepared.to, data: prepared.data as Hex }));
  }
  const successorSig = await successor.sign({ hash: await client.readContract({ ...account, functionName: 'successionAcceptanceHash', args: [successionId] }) as Hex });
  prepared = await gateway.prepareContinuity(account.address, successor.address, { operation: 'acceptSuccession', id: successionId.toString(), signature: successorSig });
  await mined(await walletFor(successor).sendTransaction({ to: prepared.to, data: prepared.data as Hex }));
  await rpc('evm_increaseTime', [14 * 86400 + 1]); await rpc('evm_mine', []); rpcOffset += (14 * 86400 + 1) * 1000;
  prepared = await gateway.prepareContinuity(account.address, recoveryParent.address, { operation: 'executeSuccession', id: successionId.toString(), planHash, evidenceHash: successionEvidence });
  const successionExecutionReceipt = await mined(await walletFor(recoveryParent).sendTransaction({ to: prepared.to, data: prepared.data as Hex }));
  await finalize();
  check(await gateway.confirmContinuityExecution({ type: 'succession', account: account.address, chainCaseId: successionId.toString(), successor: successor.address, transactionHash: successionExecutionReceipt.transactionHash }), 'succession execution receipt proof failed');
  check((await client.readContract({ ...account, functionName: 'parent' }) as Address).toLowerCase() === successor.address.toLowerCase(), 'succession parent mismatch');
  check((await gateway.getAccountAuthority(account.address)).securityEpoch === '3', 'succession did not rotate security epoch');
  check(await client.readContract({ ...account, functionName: 'delegatedSpendingPaused' }) === true, 'succession did not pause delegated spending');
  console.log(JSON.stringify({ status: 'passed', checks, chainId: 31337, scope: 'local deployed account; gateway-prepared incapacity, recovery, succession transitions with finality and receipt binding', realFunds: false }));
} finally { processHandle.kill(); await processHandle.exited; }
