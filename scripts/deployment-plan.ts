/**
 * Build an unsigned contract-deployment transaction from local Foundry
 * artifacts. This module never reads keys/env, estimates gas, signs, sends,
 * or connects to an RPC.
 *
 *   bun scripts/deployment-plan.ts --config=/path/to/public-config.json
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { getContractAddress, encodeDeployData, keccak256, toHex, type Address, type Hex } from 'viem';

export const DEPLOYMENT_CHAIN_ID = 4663;
export const MAX_RUNTIME_BYTES = 24_576; // EIP-170
export const MAX_INITCODE_BYTES = 49_152; // EIP-3860
export const ARTIFACTS = {
  factory: 'contracts/out/StewardFactoryV1.sol/StewardFactoryV1.json',
  passkey: 'contracts/out/StewardPasskeySignerV1.sol/StewardPasskeySignerV1.json',
  account: 'contracts/out/StewardAccountV1.sol/StewardAccountV1.json',
} as const;
export const SOURCES = {
  factory: 'contracts/src/StewardFactoryV1.sol',
  passkey: 'contracts/src/StewardPasskeySignerV1.sol',
  account: 'contracts/src/StewardAccountV1.sol',
} as const;

type ContractSelection = 'factory' | 'passkey';
type RehearsalMode = 'public' | 'local-rehearsal';
export type PublicDeploymentConfig = {
  chainId: number;
  mode?: RehearsalMode;
  deployer: string;
  nonce: string | number;
  contract: ContractSelection;
  passkey?: {
    rpIdHash: string;
    origin: string;
    publicKeyX: string;
    publicKeyY: string;
    enrolledEpoch: string | number;
  };
};

type SourceEvidence = {
  sha256: string;
  metadataKeccak256: string;
};
type ArtifactEvidence = {
  artifactPath: string;
  artifactBytes: Uint8Array;
  artifact: any;
  artifactSha256: string;
  metadataSha256: string;
  sourceManifestSha256: string;
  sourceFiles: Record<string, SourceEvidence>;
  creation: Hex;
  runtime: Hex;
  creationByteLength: number;
  runtimeByteLength: number;
};

export type DeploymentPlan = {
  schemaVersion: 'steward-unsigned-deployment-v1';
  chainId: number;
  mode: RehearsalMode;
  deployer: Address;
  nonce: string;
  contract: ContractSelection;
  artifactPath: string;
  artifactSha256: string;
  sourcePath: string;
  sourceSha256: string;
  sourceMetadataSha256: string;
  sourceManifestSha256: string;
  sourceFiles: Record<string, SourceEvidence>;
  creationByteLength: number;
  runtimeByteLength: number;
  embeddedAccount?: {
    artifactPath: string;
    artifactSha256: string;
    sourceManifestSha256: string;
    creationByteLength: number;
    runtimeByteLength: number;
    creationCodeKeccak256: string;
    embeddedInFactoryCreation: true;
  };
  constructorArgs: unknown[];
  initCode: Hex;
  initCodeByteLength: number;
  predictedCreateAddress: Address;
  transaction: { to: null; value: '0x0'; data: Hex; nonce: string; chainId: number; gas: null };
  checks: {
    eip170RuntimeLimit: { limit: number; observed: number; ok: true };
    eip3860InitcodeLimit: { limit: number; observed: number; ok: true };
    gasEstimate: null;
    broadcasted: false;
  };
};

const P256_P = BigInt('0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff');
const P256_B = BigInt('0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b');
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^(0|[1-9][0-9]*)$/;

function fail(message: string): never { throw new Error(`DEPLOYMENT_CONFIG_INVALID: ${message}`); }
function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${label}.${key} is not allowed`);
}
function asBytes(value: unknown, field: string): string {
  if (typeof value !== 'string' || !HEX32.test(value)) fail(`${field} must be a 32-byte hex value`);
  return value.toLowerCase();
}
function asAddress(value: unknown, field: string): Address {
  if (typeof value !== 'string' || !ADDRESS.test(value)) fail(`${field} must be a 20-byte hex address`);
  if (/^0x0{40}$/i.test(value)) fail(`${field} must not be zero`);
  return value as Address;
}
function asUint(value: unknown, field: string, max: bigint): bigint {
  const raw = typeof value === 'number' ? (Number.isSafeInteger(value) ? String(value) : '') : value;
  if (typeof raw !== 'string' || !UINT.test(raw)) fail(`${field} must be a non-negative decimal integer without leading zeroes`);
  const parsed = BigInt(raw);
  if (parsed > max) fail(`${field} exceeds ${max.toString()}`);
  return parsed;
}
function isValidP256Point(xHex: string, yHex: string) {
  const x = BigInt(xHex), y = BigInt(yHex);
  if (x <= 0n || y <= 0n || x >= P256_P || y >= P256_P) return false;
  return (y * y - ((x * x % P256_P) * x % P256_P) + 3n * x - P256_B) % P256_P === 0n;
}
function sha256(value: Uint8Array) { return createHash('sha256').update(value).digest('hex'); }
function bytecodeObject(artifact: any, field: 'bytecode' | 'deployedBytecode', artifactPath: string) {
  const object = artifact?.[field]?.object;
  if (typeof object !== 'string' || !/^0x[0-9a-fA-F]*$/.test(object) || object.length % 2 !== 0 || object === '0x') fail(`${artifactPath} has no valid ${field}.object`);
  return object as Hex;
}
function bytes(hex: string) { return (hex.length - 2) / 2; }
function sourceOnDisk(root: string, sourcePath: string) {
  const base = resolve(root);
  const candidate = resolve(base, 'contracts', sourcePath);
  const escaped = relative(base, candidate);
  if (escaped.startsWith('..') || isAbsolute(escaped)) fail(`artifact source path escapes repository: ${sourcePath}`);
  return candidate;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function validateConfig(input: unknown): PublicDeploymentConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('config must be an object');
  const value = input as Record<string, unknown>;
  assertExactKeys(value, ['chainId', 'mode', 'deployer', 'nonce', 'contract', 'passkey'], 'config');
  if (typeof value.chainId !== 'number' || !Number.isSafeInteger(value.chainId) || value.chainId <= 0) fail('chainId must be a safe positive integer');
  const mode = value.mode === undefined ? 'public' : value.mode;
  if (mode !== 'public' && mode !== 'local-rehearsal') fail('mode must be public or local-rehearsal');
  if (value.chainId === 31337 && mode !== 'local-rehearsal') fail('chainId 31337 requires mode=local-rehearsal');
  if (mode === 'local-rehearsal' && value.chainId !== 31337) fail('mode=local-rehearsal requires chainId 31337');
  const deployer = asAddress(value.deployer, 'deployer');
  asUint(value.nonce, 'nonce', 18_446_744_073_709_551_615n);
  if (value.contract !== 'factory' && value.contract !== 'passkey') fail('contract must be factory or passkey');
  if (value.contract === 'factory' && value.passkey !== undefined) fail('passkey config is only valid for contract=passkey');
  const normalizedBase = { chainId: value.chainId, mode, deployer, nonce: typeof value.nonce === 'number' ? value.nonce : value.nonce as string, contract: value.contract } as const;
  if (value.contract === 'passkey') {
    const passkey = value.passkey;
    if (!passkey || typeof passkey !== 'object' || Array.isArray(passkey)) fail('passkey config is required for contract=passkey');
    const p = passkey as Record<string, unknown>;
    assertExactKeys(p, ['rpIdHash', 'origin', 'publicKeyX', 'publicKeyY', 'enrolledEpoch'], 'passkey');
    const rpIdHash = asBytes(p.rpIdHash, 'passkey.rpIdHash');
    if (/^0x0{64}$/.test(rpIdHash)) fail('passkey.rpIdHash must not be zero');
    if (typeof p.origin !== 'string' || p.origin.length === 0 || p.origin.length > 255) fail('passkey.origin must be 1..255 characters');
    let origin: URL;
    try { origin = new URL(p.origin); } catch { fail('passkey.origin must be an absolute URL'); }
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.hash || origin.search || p.origin !== origin.origin) fail('passkey.origin must be the canonical https origin without credentials/path/query/fragment');
    const publicKeyX = asBytes(p.publicKeyX, 'passkey.publicKeyX');
    const publicKeyY = asBytes(p.publicKeyY, 'passkey.publicKeyY');
    if (!isValidP256Point(publicKeyX, publicKeyY)) fail('passkey publicKeyX/publicKeyY are not a valid P-256 point');
    const enrolledEpoch = asUint(p.enrolledEpoch, 'passkey.enrolledEpoch', (1n << 256n) - 1n);
    if (enrolledEpoch === 0n) fail('passkey.enrolledEpoch must be greater than zero');
    return { ...normalizedBase, contract: 'passkey', passkey: { rpIdHash, origin: p.origin, publicKeyX, publicKeyY, enrolledEpoch: typeof p.enrolledEpoch === 'number' ? p.enrolledEpoch : p.enrolledEpoch as string } };
  }
  return normalizedBase;
}

async function loadArtifactEvidence(root: string, artifactPath: string, primarySourcePath: string): Promise<ArtifactEvidence> {
  const fullArtifactPath = `${root}/${artifactPath}`;
  if (!existsSync(fullArtifactPath)) fail(`artifact missing: ${artifactPath}`);
  const artifactBytes = await readFile(fullArtifactPath);
  let artifact: any;
  try { artifact = JSON.parse(artifactBytes.toString('utf8')); } catch { fail(`artifact is not valid JSON: ${artifactPath}`); }
  const creation = bytecodeObject(artifact, 'bytecode', artifactPath);
  const runtime = bytecodeObject(artifact, 'deployedBytecode', artifactPath);
  const metadata = typeof artifact.metadata === 'string' ? (() => { try { return JSON.parse(artifact.metadata); } catch { fail(`${artifactPath} metadata is not valid JSON`); } })() : artifact.metadata;
  if (!metadata || typeof metadata !== 'object' || !metadata.sources || typeof metadata.sources !== 'object') fail(`${artifactPath} is missing compiler metadata sources`);
  const sourceFiles: Record<string, SourceEvidence> = {};
  for (const sourcePath of Object.keys(metadata.sources).sort()) {
    const expected = metadata.sources[sourcePath]?.keccak256;
    if (typeof expected !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(expected)) fail(`${artifactPath} metadata source ${sourcePath} has no keccak256`);
    const fullSourcePath = sourceOnDisk(root, sourcePath);
    let sourceBytes: Uint8Array;
    try { sourceBytes = await readFile(fullSourcePath); } catch { fail(`artifact metadata source missing: ${sourcePath}`); }
    const actual = keccak256(toHex(sourceBytes));
    if (actual.toLowerCase() !== expected.toLowerCase()) fail(`artifact metadata/source mismatch: ${sourcePath}`);
    sourceFiles[sourcePath] = { sha256: sha256(sourceBytes), metadataKeccak256: actual };
  }
  if (!sourceFiles[primarySourcePath]) fail(`${artifactPath} metadata does not include primary source ${primarySourcePath}`);
  const sourceManifestSha256 = sha256(new TextEncoder().encode(canonical(sourceFiles)));
  return { artifactPath, artifactBytes, artifact, artifactSha256: sha256(artifactBytes), metadataSha256: sha256(new TextEncoder().encode(canonical(metadata))), sourceManifestSha256, sourceFiles, creation, runtime, creationByteLength: bytes(creation), runtimeByteLength: bytes(runtime) };
}

export async function buildPlan(input: unknown, root = '.') : Promise<DeploymentPlan> {
  const config = validateConfig(input);
  const artifactPath = ARTIFACTS[config.contract];
  const sourcePath = SOURCES[config.contract];
  const evidence = await loadArtifactEvidence(root, artifactPath, sourcePath.replace(/^contracts\//, ''));
  if (evidence.runtimeByteLength > MAX_RUNTIME_BYTES) fail(`runtime bytecode ${evidence.runtimeByteLength} exceeds EIP-170 limit ${MAX_RUNTIME_BYTES}`);
  if (evidence.creationByteLength > MAX_INITCODE_BYTES) fail(`creation bytecode ${evidence.creationByteLength} exceeds EIP-3860 limit ${MAX_INITCODE_BYTES}`);
  let embeddedAccount: DeploymentPlan['embeddedAccount'];
  if (config.contract === 'factory') {
    const account = await loadArtifactEvidence(root, ARTIFACTS.account, SOURCES.account.replace(/^contracts\//, ''));
    if (account.runtimeByteLength > MAX_RUNTIME_BYTES) fail(`embedded account runtime bytecode ${account.runtimeByteLength} exceeds EIP-170 limit ${MAX_RUNTIME_BYTES}`);
    if (account.creationByteLength > MAX_INITCODE_BYTES) fail(`embedded account creation bytecode ${account.creationByteLength} exceeds EIP-3860 limit ${MAX_INITCODE_BYTES}`);
    if (!evidence.creation.toLowerCase().includes(account.creation.slice(2).toLowerCase())) fail('factory artifact does not embed the current StewardAccountV1 creation bytecode');
    embeddedAccount = { artifactPath: account.artifactPath, artifactSha256: account.artifactSha256, sourceManifestSha256: account.sourceManifestSha256, creationByteLength: account.creationByteLength, runtimeByteLength: account.runtimeByteLength, creationCodeKeccak256: keccak256(account.creation), embeddedInFactoryCreation: true };
  }
  const constructorArgs: unknown[] = config.contract === 'factory' ? [] : [config.passkey!.rpIdHash, config.passkey!.origin, config.passkey!.publicKeyX, config.passkey!.publicKeyY, BigInt(config.passkey!.enrolledEpoch)];
  const initCode = encodeDeployData({ abi: evidence.artifact.abi, bytecode: evidence.creation, args: constructorArgs } as any);
  const initBytes = bytes(initCode);
  if (initBytes > MAX_INITCODE_BYTES) fail(`initcode ${initBytes} exceeds EIP-3860 limit ${MAX_INITCODE_BYTES}`);
  const nonce = BigInt(config.nonce);
  const predictedCreateAddress = getContractAddress({ from: config.deployer as Address, nonce });
  const primarySource = evidence.sourceFiles[sourcePath.replace(/^contracts\//, '')];
  return {
    schemaVersion: 'steward-unsigned-deployment-v1', chainId: config.chainId, mode: config.mode!, deployer: config.deployer as Address,
    nonce: nonce.toString(), contract: config.contract, artifactPath, artifactSha256: evidence.artifactSha256, sourcePath, sourceSha256: primarySource.sha256, sourceMetadataSha256: evidence.metadataSha256, sourceManifestSha256: evidence.sourceManifestSha256, sourceFiles: evidence.sourceFiles,
    creationByteLength: evidence.creationByteLength, runtimeByteLength: evidence.runtimeByteLength, embeddedAccount, constructorArgs,
    initCode, initCodeByteLength: initBytes, predictedCreateAddress,
    transaction: { to: null, value: '0x0', data: initCode, nonce: nonce.toString(), chainId: config.chainId, gas: null },
    checks: { eip170RuntimeLimit: { limit: MAX_RUNTIME_BYTES, observed: evidence.runtimeByteLength, ok: true }, eip3860InitcodeLimit: { limit: MAX_INITCODE_BYTES, observed: initBytes, ok: true }, gasEstimate: null, broadcasted: false },
  };
}

async function main() {
  const configArg = process.argv.find((v) => v.startsWith('--config='));
  if (!configArg) fail('use --config=/path/to/public-config.json');
  const outputArg = process.argv.find((v) => v.startsWith('--output='));
  const config = JSON.parse(await readFile(configArg.slice('--config='.length), 'utf8'));
  const plan = await buildPlan(config);
  const serialized = JSON.stringify(plan, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n';
  if (outputArg) await writeFile(outputArg.slice('--output='.length), serialized);
  else process.stdout.write(serialized);
}

if (import.meta.main) await main();
