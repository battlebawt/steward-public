/** One-time, testnet-only factory deployment and receipt/code verification. */
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, defineChain, http, keccak256, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { buildPlan } from './deployment-plan';

const RPC = 'https://rpc.testnet.chain.robinhood.com';
const CHAIN_ID = 46630;
const chain = defineChain({
  id: CHAIN_ID,
  name: 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

function arg(name: string): string {
  const value = process.argv.find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!value) throw new Error(`Missing ${name}=...`);
  return value;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

type Artifact = { deployedBytecode: { object: Hex; immutableReferences?: Record<string, { start: number; length: number }[]> } };

function maskImmutables(code: Hex, references: Artifact['deployedBytecode']['immutableReferences']): string {
  let masked = code.toLowerCase();
  for (const slots of Object.values(references ?? {})) {
    for (const { start, length } of slots) {
      const offset = 2 + start * 2;
      assert(offset + length * 2 <= masked.length, 'Immutable reference exceeds bytecode');
      masked = masked.slice(0, offset) + '00'.repeat(length) + masked.slice(offset + length * 2);
    }
  }
  return masked;
}

function matchesArtifact(actual: Hex, artifact: Artifact): boolean {
  const expected = artifact.deployedBytecode.object;
  return actual.length === expected.length &&
    maskImmutables(actual, artifact.deployedBytecode.immutableReferences) ===
      maskImmutables(expected, artifact.deployedBytecode.immutableReferences);
}

const planPath = arg('--plan');
const keyPath = arg('--key-file');
const recordPath = arg('--record');
const keyStat = statSync(keyPath);
assert(keyStat.isFile() && (keyStat.mode & 0o077) === 0, 'Testnet key file must be private (0600)');
const key = readFileSync(keyPath, 'utf8').trim() as Hex;
assert(/^0x[0-9a-fA-F]{64}$/.test(key), 'Invalid private-key file');
const account = privateKeyToAccount(key);
const savedPlan = JSON.parse(readFileSync(planPath, 'utf8'));
assert(savedPlan.chainId === CHAIN_ID && savedPlan.contract === 'factory' && savedPlan.mode === 'public', 'Plan is not the Robinhood testnet factory plan');
assert(savedPlan.deployer.toLowerCase() === account.address.toLowerCase(), 'Plan/key address mismatch');
const freshPlan = await buildPlan({ chainId: CHAIN_ID, deployer: account.address, nonce: savedPlan.nonce, contract: 'factory' });
assert(freshPlan.initCode === savedPlan.initCode && freshPlan.artifactSha256 === savedPlan.artifactSha256 &&
  freshPlan.sourceManifestSha256 === savedPlan.sourceManifestSha256 &&
  freshPlan.predictedCreateAddress.toLowerCase() === savedPlan.predictedCreateAddress.toLowerCase(), 'Saved plan no longer matches current source/artifact');

const factoryArtifactPath = 'contracts/out/StewardFactoryV1.sol/StewardFactoryV1.json';
const accountArtifactPath = 'contracts/out/StewardAccountV1.sol/StewardAccountV1.json';
const factoryArtifactBytes = readFileSync(factoryArtifactPath);
assert(sha256(factoryArtifactBytes) === freshPlan.artifactSha256, 'Factory artifact SHA-256 mismatch');
const factoryArtifact = JSON.parse(factoryArtifactBytes.toString()) as Artifact & { abi: any };
const accountArtifact = JSON.parse(readFileSync(accountArtifactPath, 'utf8')) as Artifact;
const publicClient = createPublicClient({ chain, transport: http(RPC) });
const walletClient = createWalletClient({ account, chain, transport: http(RPC) });
assert(await publicClient.getChainId() === CHAIN_ID, 'RPC is not Robinhood Chain testnet');
const nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' });
assert(nonce === Number(freshPlan.nonce), 'Deployer nonce changed; reconcile before sending');
assert((await publicClient.getBytecode({ address: freshPlan.predictedCreateAddress })) === undefined, 'Predicted factory address already has code');
const estimatedGas = await publicClient.estimateGas({ account: account.address, data: freshPlan.initCode, value: 0n });
const gas = estimatedGas * 12n / 10n;
const gasPrice = await publicClient.getGasPrice();
const balance = await publicClient.getBalance({ address: account.address });
assert(balance > gas * gasPrice * 2n, 'Insufficient test ETH for a two-times fee buffer');

const prepared = {
  network: 'Robinhood Chain Testnet', chainId: CHAIN_ID, deployer: account.address,
  nonce, predictedFactory: freshPlan.predictedCreateAddress,
  artifactSha256: freshPlan.artifactSha256, sourceManifestSha256: freshPlan.sourceManifestSha256,
  initCodeKeccak256: keccak256(freshPlan.initCode), estimatedGas: estimatedGas.toString(),
  gasLimit: gas.toString(), status: 'prepared',
};
writeFileSync(recordPath, JSON.stringify(prepared, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
let hash: Hex;
try {
  hash = await walletClient.sendTransaction({ account, chain, data: freshPlan.initCode, value: 0n, nonce, gas } as any);
} catch (error) {
  writeFileSync(recordPath, JSON.stringify({ ...prepared, status: 'broadcast_outcome_unknown', error: String(error) }, null, 2) + '\n', { mode: 0o600 });
  throw error;
}
writeFileSync(recordPath, JSON.stringify({ ...prepared, status: 'broadcast', transactionHash: hash }, null, 2) + '\n', { mode: 0o600 });

const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 3, timeout: 120_000 });
const transaction = await publicClient.getTransaction({ hash });
assert(receipt.status === 'success', 'Factory transaction reverted');
assert(receipt.contractAddress?.toLowerCase() === freshPlan.predictedCreateAddress.toLowerCase(), 'Factory address mismatch');
assert(transaction.from.toLowerCase() === account.address.toLowerCase() && transaction.to === null &&
  transaction.nonce === nonce && transaction.input === freshPlan.initCode && transaction.value === 0n, 'Mined transaction differs from reviewed plan');
const factory = receipt.contractAddress as Address;
const factoryCode = await publicClient.getBytecode({ address: factory, blockNumber: receipt.blockNumber });
assert(factoryCode && matchesArtifact(factoryCode, factoryArtifact), 'Factory runtime bytecode differs from artifact');
const implementation = await publicClient.readContract({ address: factory, abi: factoryArtifact.abi, functionName: 'implementation', blockNumber: receipt.blockNumber } as any) as Address;
const embeddedHash = await publicClient.readContract({ address: factory, abi: factoryArtifact.abi, functionName: 'accountCreationCodeHash', blockNumber: receipt.blockNumber } as any) as Hex;
assert(embeddedHash.toLowerCase() === freshPlan.embeddedAccount?.creationCodeKeccak256.toLowerCase(), 'Embedded account creation hash mismatch');
const implementationCode = await publicClient.getBytecode({ address: implementation, blockNumber: receipt.blockNumber });
assert(implementationCode && matchesArtifact(implementationCode, accountArtifact), 'Implementation runtime bytecode differs from artifact');
const result = {
  ...prepared, status: 'verified', transactionHash: hash,
  blockNumber: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString(),
  factory, factoryRuntimeKeccak256: keccak256(factoryCode),
  implementation, implementationRuntimeKeccak256: keccak256(implementationCode),
  accountCreationCodeHash: embeddedHash,
};
writeFileSync(recordPath, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(result));
