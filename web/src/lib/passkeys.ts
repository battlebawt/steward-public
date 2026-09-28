import { encodeAbiParameters, encodeFunctionData, hashMessage, keccak256, hexToBytes, stringToHex, type Hex } from "viem";
import { STEWARD_PASSKEY_SIGNER_CREATION_CODE } from "./passkeyArtifact";

const P256_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const P256_HALF_ORDER = 0x7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a8n;
const UINT64_MAX = (1n << 64n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;
const PASSKEY_CALL_VERSION = keccak256(stringToHex("STEWARD_PASSKEY_CALL_V1"));

export interface PasskeyCall {
  signerAddress: `0x${string}`;
  chainId: string | number | bigint;
  target: `0x${string}`;
  value: string | number | bigint;
  data: Hex;
  nonce: string | number | bigint;
  deadline: string | number | bigint;
}

export interface EncodedPasskeyCall extends PasskeyCall {
  signature: Hex;
}

function uint(value: string | number | bigint, name: string, max: bigint): bigint {
  let parsed: bigint;
  if (typeof value === "bigint") parsed = value;
  else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a safe integer.`);
    parsed = BigInt(value);
  } else if (/^(0|[1-9][0-9]*)$/.test(value)) parsed = BigInt(value);
  else throw new Error(`${name} must be an unsigned integer string.`);
  if (parsed < 0n || parsed > max) throw new Error(`${name} is out of range.`);
  return parsed;
}

/** Hash the exact sponsored call envelope accepted by StewardPasskeySignerV1. */
export function hashPasskeyCall(call: PasskeyCall): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint64" }],
    [PASSKEY_CALL_VERSION, call.signerAddress, uint(call.chainId, "chainId", UINT256_MAX), call.target, uint(call.value, "value", UINT256_MAX), keccak256(call.data), uint(call.nonce, "nonce", UINT256_MAX), uint(call.deadline, "deadline", UINT64_MAX)],
  ));
}

/** Encode execute(target,value,data,nonce,deadline,signature) for a sponsored signer call. */
export function encodePasskeyCall(call: EncodedPasskeyCall): Hex {
  const nonce = uint(call.nonce, "nonce", UINT256_MAX);
  const deadline = uint(call.deadline, "deadline", UINT64_MAX);
  return encodeFunctionData({
    abi: [{ type: "function", name: "execute", stateMutability: "payable", inputs: [
      { name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" },
      { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint64" }, { name: "signature", type: "bytes" },
    ], outputs: [] }],
    functionName: "execute",
    args: [call.target, uint(call.value, "value", UINT256_MAX), call.data, nonce, deadline, call.signature],
  });
}

export interface PasskeyDeploymentTemplate {
  chainId: number;
  bytecode: Hex;
  bytecodeHash: `0x${string}`;
  rpId: string;
  origin: string;
  enrolledEpoch: string;
}

/** Encode the immutable signer creation bytecode from the server-pinned template. */
export function encodePasskeySignerDeployment(template: PasskeyDeploymentTemplate, key: Pick<PasskeyPublicKey, "rpIdHash" | "publicKeyX" | "publicKeyY">): Hex {
  if (!/^0x[0-9a-fA-F]*$/.test(template.bytecode) || template.bytecode.length < 4) throw new Error("Signer deployment bytecode is invalid.");
  if (template.bytecode.toLowerCase() !== STEWARD_PASSKEY_SIGNER_CREATION_CODE.toLowerCase()) throw new Error("Signer deployment bytecode is not the compiled StewardPasskeySignerV1 artifact.");
  if (keccak256(template.bytecode).toLowerCase() !== template.bytecodeHash.toLowerCase()) throw new Error("Signer deployment bytecode hash does not match the server pin.");
  if (!template.origin || template.origin.length > 255 || !template.rpId) throw new Error("Signer deployment template is incomplete.");
  if (key.rpIdHash === "0x" + "00".repeat(32)) throw new Error("Passkey relying-party hash is empty.");
  const constructor = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "string" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }],
    [key.rpIdHash, template.origin, key.publicKeyX, key.publicKeyY, uint(template.enrolledEpoch, "enrolledEpoch", UINT256_MAX)],
  );
  return (`${template.bytecode}${constructor.slice(2)}`) as Hex;
}

export function encodePasskeyCallNonce(): Hex {
  return encodeFunctionData({ abi: [{ type: "function", name: "callNonce", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }], functionName: "callNonce", args: [] });
}

export async function verifyPasskeyDeploymentTemplate(template: PasskeyDeploymentTemplate, key: Pick<PasskeyPublicKey, "rpIdHash">): Promise<void> {
  const digest = asHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(template.rpId)));
  if (digest.toLowerCase() !== key.rpIdHash.toLowerCase()) throw new Error("Passkey relying-party hash does not match the deployment template.");
}

export interface PasskeyCreationOptions extends Omit<PublicKeyCredentialCreationOptions, "challenge" | "user"> {
  /** Server-issued base64url challenge. */
  challenge: string;
  user: Omit<PublicKeyCredentialUserEntity, "id"> & { id: string };
}

export interface PasskeyRequestOptions extends Omit<PublicKeyCredentialRequestOptions, "challenge" | "allowCredentials"> {
  allowCredentials?: Array<Omit<PublicKeyCredentialDescriptor, "id"> & { id: string }>;
}

export interface CreatedPasskey {
  id: string;
  rawId: string;
  clientDataJSON: string;
  attestationObject: string;
  transports: string[];
}

export interface PasskeyPublicKey {
  /** SHA-256 hash of the relying-party ID from authenticatorData. */
  rpIdHash: Hex;
  /** Credential ID returned by the authenticator, encoded for API transport. */
  credentialId: string;
  publicKeyX: Hex;
  publicKeyY: Hex;
}

export interface PasskeyAssertion {
  id: string;
  rawId: string;
  authenticatorData: Hex;
  clientDataJSON: string;
  signature: Hex;
  userHandle?: Hex;
}

type CborValue = Uint8Array | string | number | bigint | CborValue[] | Map<number | string | bigint, CborValue> | boolean | null;

function cborLength(input: Uint8Array, offset: number, info: number): { length: number; next: number } {
  if (info < 24) return { length: info, next: offset };
  const width = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
  if (!width || offset + width > input.length) throw new Error("Invalid CBOR length.");
  let length = 0n;
  for (let i = 0; i < width; i += 1) length = (length << 8n) | BigInt(input[offset + i]);
  if (length > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("CBOR length is too large.");
  return { length: Number(length), next: offset + width };
}

function readCbor(input: Uint8Array, start = 0): { value: CborValue; next: number } {
  if (start >= input.length) throw new Error("Invalid CBOR value.");
  const head = input[start]; const major = head >> 5; const info = head & 0x1f;
  if (info === 31) throw new Error("Indefinite CBOR values are not supported.");
  let cursor = start + 1;
  if (major === 0 || major === 1) {
    const size = cborLength(input, cursor, info); cursor = size.next;
    const unsigned = BigInt(size.length);
    return { value: major === 0 ? unsigned : -1n - unsigned, next: cursor };
  }
  if (major === 2 || major === 3) {
    const size = cborLength(input, cursor, info); cursor = size.next;
    if (cursor + size.length > input.length) throw new Error("CBOR value exceeds attestation object.");
    const bytes = input.slice(cursor, cursor + size.length);
    return { value: major === 2 ? bytes : new TextDecoder().decode(bytes), next: cursor + size.length };
  }
  if (major === 4) {
    const size = cborLength(input, cursor, info); cursor = size.next; const values: CborValue[] = [];
    for (let i = 0; i < size.length; i += 1) { const child = readCbor(input, cursor); values.push(child.value); cursor = child.next; }
    return { value: values, next: cursor };
  }
  if (major === 5) {
    const size = cborLength(input, cursor, info); cursor = size.next; const values = new Map<number | string | bigint, CborValue>();
    for (let i = 0; i < size.length; i += 1) {
      const key = readCbor(input, cursor); cursor = key.next; const child = readCbor(input, cursor); cursor = child.next;
      if (typeof key.value !== "string" && typeof key.value !== "number" && typeof key.value !== "bigint") throw new Error("Invalid CBOR map key.");
      let normalized: number | string | bigint = key.value;
      if (typeof key.value === "bigint" && key.value <= BigInt(Number.MAX_SAFE_INTEGER) && key.value >= BigInt(Number.MIN_SAFE_INTEGER)) normalized = Number(key.value);
      values.set(normalized, child.value);
    }
    return { value: values, next: cursor };
  }
  if (major === 6) return readCbor(input, cursor);
  if (major === 7) {
    if (info === 20) return { value: false, next: cursor }; if (info === 21) return { value: true, next: cursor }; if (info === 22) return { value: null, next: cursor };
  }
  throw new Error("Unsupported CBOR value.");
}

/** Extract the immutable signer constructor inputs from a browser attestation. */
export function extractPasskeyPublicKey(credential: Pick<CreatedPasskey, "rawId" | "attestationObject">): PasskeyPublicKey {
  const attestation = readCbor(base64urlToBytes(credential.attestationObject)).value;
  if (!(attestation instanceof Map)) throw new Error("Attestation object is not a CBOR map.");
  const authData = attestation.get("authData");
  if (!(authData instanceof Uint8Array) || authData.length < 55) throw new Error("Attestation has no authenticator data.");
  const flags = authData[32]; if ((flags & 0x40) === 0) throw new Error("Credential data is missing from the attestation.");
  const credentialLength = (authData[53] << 8) | authData[54]; const credentialStart = 55; const coseStart = credentialStart + credentialLength;
  if (coseStart > authData.length) throw new Error("Attestation credential ID is truncated.");
  const cose = readCbor(authData, coseStart).value;
  if (!(cose instanceof Map)) throw new Error("Attestation public key is not a COSE map.");
  const x = cose.get(-2); const y = cose.get(-3);
  if (!(x instanceof Uint8Array) || x.length !== 32 || !(y instanceof Uint8Array) || y.length !== 32) throw new Error("Attestation does not contain a P-256 public key.");
  return { rpIdHash: asHex(authData.slice(0, 32)), credentialId: credential.rawId, publicKeyX: asHex(x), publicKeyY: asHex(y) };
}

export function passkeyChallenge(digest: Hex, _signerAddress?: `0x${string}`): Hex {
  // Must remain byte-for-byte identical to StewardPasskeySignerV1.challengeFor.
  // The account/action hash already supplies domain separation; the browser
  // challenge is the exact digest passed to ERC-1271.
  return digest;
}

/** The server challenge message is signed as an EIP-191 personal-message digest. */
export function passkeyMessageDigest(message: string): Hex {
  return hashMessage(message);
}

export function base64urlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const decoded = atob(padded);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes;
}

export function bytesToBase64url(input: ArrayBuffer | ArrayBufferView): string {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + 0x8000, bytes.length)));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function asHex(input: ArrayBuffer | ArrayBufferView): Hex {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return (`0x${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`) as Hex;
}

export async function createPasskeyCredential(options: PasskeyCreationOptions): Promise<CreatedPasskey> {
  if (!navigator.credentials?.create) throw new Error("This browser does not provide WebAuthn credential creation.");
  const credential = await navigator.credentials.create({
    publicKey: {
      ...options,
      challenge: base64urlToBytes(options.challenge),
      user: { ...options.user, id: base64urlToBytes(options.user.id) },
    } as PublicKeyCredentialCreationOptions,
  });
  if (typeof PublicKeyCredential === "undefined" || typeof AuthenticatorAttestationResponse === "undefined"
    || !(credential instanceof PublicKeyCredential) || !(credential.response instanceof AuthenticatorAttestationResponse)) {
    throw new Error("The browser did not return a passkey attestation.");
  }
  return {
    id: credential.id,
    rawId: bytesToBase64url(credential.rawId),
    clientDataJSON: bytesToBase64url(credential.response.clientDataJSON),
    attestationObject: bytesToBase64url(credential.response.attestationObject),
    transports: credential.response.getTransports?.() ?? [],
  };
}

export async function getPasskeyAssertion(
  digest: Hex,
  signerAddress: `0x${string}`,
  options: PasskeyRequestOptions = {},
): Promise<PasskeyAssertion> {
  if (!navigator.credentials?.get) throw new Error("This browser does not provide WebAuthn assertion signing.");
  const publicKey: PublicKeyCredentialRequestOptions = {
    ...options,
    challenge: hexToBytes(passkeyChallenge(digest, signerAddress)),
    allowCredentials: options.allowCredentials?.map((credential) => ({
      ...credential,
      id: base64urlToBytes(credential.id),
    })),
  } as PublicKeyCredentialRequestOptions;
  const credential = await navigator.credentials.get({ publicKey });
  if (typeof PublicKeyCredential === "undefined" || typeof AuthenticatorAssertionResponse === "undefined"
    || !(credential instanceof PublicKeyCredential) || !(credential.response instanceof AuthenticatorAssertionResponse)) {
    throw new Error("The browser did not return a passkey assertion.");
  }
  return {
    id: credential.id,
    rawId: bytesToBase64url(credential.rawId),
    authenticatorData: asHex(credential.response.authenticatorData),
    clientDataJSON: new TextDecoder().decode(credential.response.clientDataJSON),
    signature: asHex(credential.response.signature),
    userHandle: credential.response.userHandle ? asHex(credential.response.userHandle) : undefined,
  };
}

function derLength(input: Uint8Array, cursor: number): { length: number; next: number } {
  if (cursor >= input.length) throw new Error("Invalid DER signature length.");
  const first = input[cursor++];
  if (first < 0x80) return { length: first, next: cursor };
  const octets = first & 0x7f;
  if (octets === 0 || octets > 2 || cursor + octets > input.length) throw new Error("Invalid DER signature length.");
  let length = 0;
  for (let index = 0; index < octets; index += 1) length = length * 256 + input[cursor++];
  return { length, next: cursor };
}

function derInteger(input: Uint8Array, cursor: number): { value: Hex; next: number } {
  if (input[cursor++] !== 0x02) throw new Error("Invalid DER ECDSA integer.");
  const encodedLength = derLength(input, cursor);
  cursor = encodedLength.next;
  if (encodedLength.length === 0 || cursor + encodedLength.length > input.length) throw new Error("Invalid DER ECDSA integer.");
  let value = input.slice(cursor, cursor + encodedLength.length);
  // DER INTEGERs are signed. Reject negative values and redundant sign bytes;
  // a single leading zero is valid only when it protects a high-bit value.
  if ((value[0] & 0x80) !== 0) throw new Error("Invalid negative DER ECDSA integer.");
  if (value.length > 1 && value[0] === 0 && (value[1] & 0x80) === 0) throw new Error("Invalid non-minimal DER ECDSA integer.");
  if (value.length === 33 && value[0] === 0) value = value.slice(1);
  if (value.length > 32 || value.length === 0) throw new Error("Invalid DER ECDSA integer width.");
  const padded = new Uint8Array(32);
  padded.set(value, 32 - value.length);
  return { value: asHex(padded), next: cursor + encodedLength.length };
}

/** WebAuthn returns DER ECDSA, while the P-256 precompile takes fixed r and s words. */
export function parseDerSignature(signature: ArrayBuffer | ArrayBufferView | Hex): { r: Hex; s: Hex } {
  const input = typeof signature === "string"
    ? hexToBytes(signature)
    : signature instanceof ArrayBuffer
      ? new Uint8Array(signature)
      : new Uint8Array(signature.buffer, signature.byteOffset, signature.byteLength);
  if (input[0] !== 0x30) throw new Error("Invalid DER ECDSA signature.");
  const sequence = derLength(input, 1);
  if (sequence.next + sequence.length !== input.length) throw new Error("Invalid DER ECDSA sequence length.");
  const r = derInteger(input, sequence.next);
  const s = derInteger(input, r.next);
  if (s.next !== input.length) throw new Error("Invalid DER ECDSA trailing data.");
  const rNumber = BigInt(r.value);
  const sNumber = BigInt(s.value);
  if (rNumber <= 0n || rNumber >= P256_ORDER || sNumber <= 0n || sNumber >= P256_ORDER) throw new Error("Invalid P-256 ECDSA scalar.");
  const lowS = sNumber > P256_HALF_ORDER ? P256_ORDER - sNumber : sNumber;
  return { r: r.value, s: (`0x${lowS.toString(16).padStart(64, "0")}`) as Hex };
}

export function encodePasskeySignature(assertion: PasskeyAssertion): Hex {
  const { r, s } = parseDerSignature(assertion.signature);
  return encodeAbiParameters(
    [{ type: "bytes" }, { type: "string" }, { type: "bytes32" }, { type: "bytes32" }],
    [assertion.authenticatorData, assertion.clientDataJSON, r, s],
  );
}

/** Existing account envelope: signer address plus the signer-specific assertion bytes. */
export function wrapErc1271Signature(signerAddress: `0x${string}`, signerSignature: Hex): Hex {
  return encodeAbiParameters([{ type: "address" }, { type: "bytes" }], [signerAddress, signerSignature]);
}
