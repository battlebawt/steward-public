/** One-time public testnet rehearsal with a generated P-256 fixture, never a user credential. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { bytesToHex, createPublicClient, createWalletClient, decodeEventLog, defineChain, encodeAbiParameters, encodeFunctionData, hashMessage, http, keccak256, sha256, stringToHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { buildPlan } from './deployment-plan';
import { VerifiedLiveChainGateway } from '../server/src/integrations/live-chain';
import { ReadRpcPool } from '../server/src/integrations/rpc';

const rpc = 'https://rpc.testnet.chain.robinhood.com';
const chainId = 46630;
const origin = 'https://steward.example'; // Reserved, synthetic fixture origin; not a user-facing RP.
const rpId = 'steward.example';
const chain = defineChain({ id: chainId, name: 'Robinhood Chain Testnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
function assert(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
function privateFile(path: string) { const file = statSync(path); assert(file.isFile() && (file.mode & 0o077) === 0, `${path} must be 0600`); }
const input = process.argv.find(arg => arg.startsWith('--state-dir='))?.slice('--state-dir='.length);
assert(input, 'Use --state-dir=/path/to/private/testnet-state');
const stateDir = resolve(input);
const pathFromRepo = relative(process.cwd(), stateDir);
assert(pathFromRepo.startsWith('..') || isAbsolute(pathFromRepo), 'Private state must stay outside the repository');
const keyPath = `${stateDir}/deployer.key`;
privateFile(keyPath);
const sponsor = privateKeyToAccount(readFileSync(keyPath, 'utf8').trim() as Hex);
const initial = JSON.parse(readFileSync(`${stateDir}/account-rehearsal.json`, 'utf8'));
const factoryDeployment = JSON.parse(readFileSync(`${stateDir}/factory-deployment.json`, 'utf8'));
assert(initial.chainId === chainId && initial.parent.toLowerCase() === sponsor.address.toLowerCase() && factoryDeployment.status === 'verified', 'Fixture/chain mismatch');
const client = createPublicClient({ chain, transport: http(rpc) });
const wallet = createWalletClient({ account: sponsor, chain, transport: http(rpc) });
assert(await client.getChainId() === chainId, 'RPC is not Robinhood Chain testnet');
const factory = factoryDeployment.factory as Address;
const factoryCode = await client.getBytecode({ address: factory });
assert(factoryCode && keccak256(factoryCode).toLowerCase() === factoryDeployment.factoryRuntimeKeccak256.toLowerCase(), 'Factory code pin changed');
const fixturePath = `${stateDir}/generated-passkey-fixture.json`;
if (!existsSync(fixturePath)) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  writeFileSync(fixturePath, JSON.stringify({ origin, rpId, publicKeyX: bytesToHex(publicRaw.slice(1, 33)), publicKeyY: bytesToHex(publicRaw.slice(33)), privateJwk }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
privateFile(fixturePath);
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
assert(fixture.origin === origin && fixture.rpId === rpId, 'Generated fixture origin changed');
const privateKey = await crypto.subtle.importKey('jwk', fixture.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
const rpHash = sha256(stringToHex(rpId));
const passkeyArtifactBytes = readFileSync('contracts/out/StewardPasskeySignerV1.sol/StewardPasskeySignerV1.json');
const passkeyArtifact = JSON.parse(passkeyArtifactBytes.toString());
const factoryArtifact = JSON.parse(readFileSync('contracts/out/StewardFactoryV1.sol/StewardFactoryV1.json', 'utf8'));
const accountArtifact = JSON.parse(readFileSync('contracts/out/StewardAccountV1.sol/StewardAccountV1.json', 'utf8'));
const tokenArtifact = JSON.parse(readFileSync('contracts/out/MockStewardToken.sol/MockStewardToken.json', 'utf8'));
const recordPath = `${stateDir}/passkey-rehearsal.json`;
assert(!existsSync(recordPath), 'Passkey rehearsal already started; reconcile recorded transactions before rerunning');
const nonce = await client.getTransactionCount({ address: sponsor.address, blockTag: 'pending' });
const plan = await buildPlan({ chainId, contract: 'passkey', deployer: sponsor.address, nonce: String(nonce), passkey: { rpIdHash: rpHash, origin, publicKeyX: fixture.publicKeyX, publicKeyY: fixture.publicKeyY, enrolledEpoch: '1' } });
assert(plan.artifactSha256 === createHash('sha256').update(passkeyArtifactBytes).digest('hex'), 'Passkey artifact changed');
assert((await client.getBytecode({ address: plan.predictedCreateAddress })) === undefined, 'Predicted signer address already has code');
const estimatedGas = await client.estimateGas({ account: sponsor.address, data: plan.initCode, value: 0n });
const gas = estimatedGas * 12n / 10n;
const gasPrice = await client.getGasPrice();
assert((await client.getBalance({ address: sponsor.address })) > gas * gasPrice * 2n, 'Insufficient test ETH gas buffer');
if (process.argv.includes('--dry-run')) {
  console.log(JSON.stringify({ status: 'preflight_only', chainId, sponsor: sponsor.address, predictedSigner: plan.predictedCreateAddress, nonce: plan.nonce, artifactSha256: plan.artifactSha256, sourceManifestSha256: plan.sourceManifestSha256, estimatedGas: estimatedGas.toString(), broadcasted: false }));
  process.exit(0);
}
const record: Record<string, any> = { network: 'Robinhood Chain Testnet', chainId, sponsor: sponsor.address, origin, rpIdHash: rpHash, syntheticCredential: true, mockSettlement: initial.mockSettlement, factory, steps: [] };
const save = () => writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
save();
async function mined(label: string, hash: Hex) {
  const step: Record<string, any> = { label, transactionHash: hash, status: 'broadcast' };
  record.steps.push(step); save();
  const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 3, timeout: 120_000 });
  assert(receipt.status === 'success', `${label} reverted`);
  step.status = 'confirmed'; step.blockNumber = receipt.blockNumber.toString(); step.gasUsed = receipt.gasUsed.toString(); save();
  return receipt;
}
record.plan = { predictedAddress: plan.predictedCreateAddress, nonce: plan.nonce, artifactSha256: plan.artifactSha256, sourceManifestSha256: plan.sourceManifestSha256, initCodeKeccak256: keccak256(plan.initCode) };
save();
const deployment = await mined('deploy_generated_passkey_signer', await wallet.sendTransaction({ account: sponsor, chain, data: plan.initCode, value: 0n, nonce, gas } as any));
assert(deployment.contractAddress?.toLowerCase() === plan.predictedCreateAddress.toLowerCase(), 'Passkey signer address mismatch');
const signer = deployment.contractAddress as Address;
const deploymentTx = await client.getTransaction({ hash: record.steps[0].transactionHash });
assert(deploymentTx.from.toLowerCase() === sponsor.address.toLowerCase() && deploymentTx.to === null && deploymentTx.nonce === nonce && deploymentTx.input === plan.initCode, 'Signer deployment differs from reviewed plan');
const signerCode = await client.getBytecode({ address: signer, blockNumber: deployment.blockNumber });
assert(signerCode, 'Signer bytecode missing');
function maskImmutables(code: Hex) {
  let masked = code.toLowerCase();
  for (const slots of Object.values(passkeyArtifact.deployedBytecode.immutableReferences ?? {}) as any[]) for (const { start, length } of slots) {
    const offset = 2 + start * 2;
    masked = masked.slice(0, offset) + '00'.repeat(length) + masked.slice(offset + length * 2);
  }
  return masked;
}
assert(signerCode.length === passkeyArtifact.deployedBytecode.object.length && maskImmutables(signerCode) === maskImmutables(passkeyArtifact.deployedBytecode.object), 'Signer runtime differs from reviewed artifact');
assert(await client.readContract({ address: signer, abi: passkeyArtifact.abi, functionName: 'rpIdHash' } as any) === rpHash, 'RP hash mismatch');
assert(await client.readContract({ address: signer, abi: passkeyArtifact.abi, functionName: 'origin' } as any) === origin, 'Origin mismatch');
assert(await client.readContract({ address: signer, abi: passkeyArtifact.abi, functionName: 'publicKeyX' } as any) === fixture.publicKeyX, 'P-256 X mismatch');
assert(await client.readContract({ address: signer, abi: passkeyArtifact.abi, functionName: 'publicKeyY' } as any) === fixture.publicKeyY, 'P-256 Y mismatch');
record.signer = signer;
record.signerRuntimeKeccak256 = keccak256(signerCode);
save();
async function assertion(digest: Hex): Promise<Hex> {
  const auth = new Uint8Array(37); auth.set(Buffer.from(rpHash.slice(2), 'hex')); auth[32] = 5;
  const clientJson = JSON.stringify({ type: 'webauthn.get', challenge: Buffer.from(digest.slice(2), 'hex').toString('base64url'), origin, crossOrigin: false });
  const signed = new Uint8Array(69); signed.set(auth); signed.set(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(clientJson))), 37);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, signed));
  const n = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  const scalar = BigInt(bytesToHex(signature.slice(32)));
  const low = scalar > n / 2n ? n - scalar : scalar;
  return encodeAbiParameters([{ type: 'bytes' }, { type: 'string' }, { type: 'bytes32' }, { type: 'bytes32' }], [bytesToHex(auth), clientJson, bytesToHex(signature.slice(0, 32)), `0x${low.toString(16).padStart(64, '0')}`]);
}
const message = 'Generated test-only credential on Robinhood Chain testnet';
const authSignature = await assertion(hashMessage(message));
const gateway = new VerifiedLiveChainGateway({ rpc: new ReadRpcPool([rpc], chainId), manifest: { chainId, version: 'passkey-public-testnet-fixture', accounts: [], routes: [] } });
assert(await gateway.verifyWalletSignature({ address: signer, message, signature: authSignature }), 'Public-chain ERC-1271 passkey validation failed');
assert(!await gateway.verifyWalletSignature({ address: signer, message: `${message} changed`, signature: authSignature }), 'Altered passkey challenge accepted');
record.erc1271Valid = true;
record.alteredChallengeRejected = true;
save();
const token = initial.mockSettlement as Address;
const config = { settlement: token, period: 86_400n, anchor: 0n, paymentLimit: 100_000_000n, buyLimit: 0n, reserve: 0n, perPayment: 20_000_000n, perBuy: 0n, perSell: 0n, exceptionQuorum: 2n, approvedTokens: [], paymentRecipients: [sponsor.address], exceptionSigners: [initial.roles.exception1, initial.roles.exception2], guardians: [initial.roles.guardian1, initial.roles.guardian2, initial.roles.guardian3], approvedAdapters: [], sellCapTokens: [], sellCaps: [], continuityReviewer: '0x0000000000000000000000000000000000000000', continuitySuccessor: '0x0000000000000000000000000000000000000000', continuityPlanHash: `0x${'00'.repeat(32)}` };
const created = await mined('create_passkey_parent_account', await wallet.writeContract({ address: factory, abi: factoryArtifact.abi, functionName: 'createAccount', args: [signer, config], account: sponsor, chain }));
const event = created.logs.map(log => { try { return decodeEventLog({ abi: factoryArtifact.abi, data: log.data, topics: log.topics }) as any; } catch { return null; } }).find(value => value?.eventName === 'AccountCreated');
assert(event?.args?.parent.toLowerCase() === signer.toLowerCase(), 'Passkey-parent AccountCreated event missing');
const account = event.args.account as Address;
assert((await client.readContract({ address: account, abi: accountArtifact.abi, functionName: 'parent' } as any) as Address).toLowerCase() === signer.toLowerCase(), 'Passkey account parent mismatch');
record.account = account;
save();
await mined('fund_passkey_account_mock', await wallet.writeContract({ address: token, abi: tokenArtifact.abi, functionName: 'mint', args: [account, 100_000_000n], account: sponsor, chain }));
const amount = 10_000_000n;
const recipientBefore = await client.readContract({ address: token, abi: tokenArtifact.abi, functionName: 'balanceOf', args: [sponsor.address] } as any) as bigint;
const accountBefore = await client.readContract({ address: token, abi: tokenArtifact.abi, functionName: 'balanceOf', args: [account] } as any) as bigint;
const calldata = encodeFunctionData({ abi: accountArtifact.abi, functionName: 'withdraw', args: [token, amount, sponsor.address] });
const callNonce = await client.readContract({ address: signer, abi: passkeyArtifact.abi, functionName: 'callNonce' } as any) as bigint;
assert(callNonce === 0n, 'Passkey sponsor nonce was used');
const deadline = (await client.getBlock()).timestamp + 3600n;
const digest = await client.readContract({ address: signer, abi: passkeyArtifact.abi, functionName: 'callHash', args: [account, 0n, calldata, callNonce, deadline] } as any) as Hex;
const callSignature = await assertion(digest);
assert(await client.readContract({ address: signer, abi: passkeyArtifact.abi, functionName: 'isValidSignature', args: [digest, callSignature] } as any) === '0x1626ba7e', 'Sponsored call signature invalid');
await client.simulateContract({ address: signer, abi: passkeyArtifact.abi, functionName: 'execute', args: [account, 0n, calldata, callNonce, deadline, callSignature], account: sponsor.address });
const sponsored = await mined('sponsored_passkey_parent_withdrawal', await wallet.writeContract({ address: signer, abi: passkeyArtifact.abi, functionName: 'execute', args: [account, 0n, calldata, callNonce, deadline, callSignature], account: sponsor, chain }));
const recipientAfter = await client.readContract({ address: token, abi: tokenArtifact.abi, functionName: 'balanceOf', args: [sponsor.address] } as any) as bigint;
const accountAfter = await client.readContract({ address: token, abi: tokenArtifact.abi, functionName: 'balanceOf', args: [account] } as any) as bigint;
assert(recipientAfter === recipientBefore + amount && accountAfter === accountBefore - amount, 'Sponsored withdrawal balance mismatch');
assert(await client.readContract({ address: signer, abi: passkeyArtifact.abi, functionName: 'callNonce' } as any) === 1n, 'Passkey sponsor nonce did not advance');
let replayRejected = false;
try { await client.simulateContract({ address: signer, abi: passkeyArtifact.abi, functionName: 'execute', args: [account, 0n, calldata, callNonce, deadline, callSignature], account: sponsor.address }); }
catch (error) { replayRejected = String(error).includes('InvalidCall'); }
assert(replayRejected, 'Sponsored call replay was not rejected');
record.sponsoredWithdrawal = { amountRaw: amount.toString(), recipientBeforeRaw: recipientBefore.toString(), recipientAfterRaw: recipientAfter.toString(), accountBeforeRaw: accountBefore.toString(), accountAfterRaw: accountAfter.toString(), replayRejected, blockNumber: sponsored.blockNumber.toString() };
record.status = 'verified_generated_passkey_rehearsal';
save();
console.log(JSON.stringify({ status: record.status, chainId, signer, account, syntheticCredential: true, erc1271Valid: true, alteredChallengeRejected: true, sponsoredWithdrawalTransactionHash: record.steps.at(-1).transactionHash, replayRejected, accountMockBalanceRaw: accountAfter.toString() }));
