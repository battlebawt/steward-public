import { createWalletClient, custom, decodeFunctionResult, encodeFunctionData, stringToHex, type EIP1193Provider } from "viem";
import type { ActionIntent, PreparedTransaction } from "../domain";
import { ACTION_TYPES,actionDomain,actionMessage } from "@steward/shared";
import { verifyPreparedCall, verifyPreparedTransaction, type PreparedCall, type PreparedCallExpectations } from "./preparedTx";
import { encodePasskeyCall, encodePasskeyCallNonce, encodePasskeySignature, getPasskeyAssertion, hashPasskeyCall, type PasskeyRequestOptions } from "./passkeys";

export const DEMO_CHAIN_ID = 31337;

export interface WalletSession {
  account: `0x${string}`;
  chainId: number;
}

export async function readWalletSession(provider: EIP1193Provider): Promise<WalletSession> {
  const [account] = (await provider.request({ method: "eth_accounts" })) as string[];
  const chainHex = (await provider.request({ method: "eth_chainId" })) as string;
  if (!account) throw new Error("Connect a wallet before continuing.");
  return { account: account as `0x${string}`, chainId: Number.parseInt(chainHex, 16) };
}

export async function connectWallet(provider: EIP1193Provider): Promise<WalletSession> {
  await provider.request({ method: "eth_requestAccounts" });
  return readWalletSession(provider);
}

export function walletClient(provider: EIP1193Provider) {
  return createWalletClient({ transport: custom(provider) });
}

export async function signChallenge(provider: EIP1193Provider, challenge: string, expected: WalletSession): Promise<string> {
  const current = await readWalletSession(provider);
  assertWalletUnchanged(expected, current);
  const signature = (await (provider.request as (args: { method: string; params: unknown[] }) => Promise<unknown>)({ method: "personal_sign", params: [stringToHex(challenge), current.account] })) as string;
  assertWalletUnchanged(expected, await readWalletSession(provider));
  return signature;
}

export async function signAction(provider: EIP1193Provider, intent: ActionIntent, typedData: unknown, expected: WalletSession): Promise<string> {
  assertWalletUnchanged(expected, await readWalletSession(provider));
  const signature = (await (provider.request as (args: { method: string; params: unknown[] }) => Promise<unknown>)({ method: "eth_signTypedData_v4", params: [expected.account, JSON.stringify({domain:actionDomain(intent),types:{EIP712Domain:[{name:"name",type:"string"},{name:"version",type:"string"},{name:"chainId",type:"uint256"},{name:"verifyingContract",type:"address"}],...ACTION_TYPES},primaryType:"Action",message:actionMessage(intent)},(_k,v)=>typeof v==="bigint"?v.toString():v)] })) as string;
  assertWalletUnchanged(expected, await readWalletSession(provider));
  return signature;
}

/** Send only a transaction that has passed the local manifest and exact-action checks. */
export async function sendPreparedTransaction(provider: EIP1193Provider, intent: ActionIntent, prepared: PreparedTransaction, expected: WalletSession): Promise<`0x${string}`> {
  const verification = verifyPreparedTransaction(intent, prepared);
  if (!verification.ok) throw new Error(`Prepared transaction rejected: ${verification.reason}`);
  assertWalletUnchanged(expected, await readWalletSession(provider));
  try {
    const hash = await (provider.request as (args: { method: string; params: unknown[] }) => Promise<unknown>)({ method: "eth_sendTransaction", params: [{ from: expected.account, to: prepared.to, value: "0x0", data: prepared.data }] });
    assertWalletUnchanged(expected, await readWalletSession(provider));
    return hash as `0x${string}`;
  } catch (error) {
    // A wallet timeout may have broadcast the transaction. Callers should check
    // the original intent/hash and render checking_status before any retry.
    throw error;
  }
}

/** Send a reviewed deployment/management/continuity call after exact envelope checks. */
export async function sendPreparedCall(provider: EIP1193Provider, prepared: PreparedCall, expectations: PreparedCallExpectations, expected: WalletSession): Promise<`0x${string}`> {
  const verification = verifyPreparedCall(prepared, expectations);
  if (!verification.ok) throw new Error(`Prepared transaction rejected: ${verification.reason}`);
  assertWalletUnchanged(expected, await readWalletSession(provider));
  try {
    const hash = await (provider.request as (args: { method: string; params: unknown[] }) => Promise<unknown>)({
      method: "eth_sendTransaction",
      params: [{ from: expected.account, to: prepared.to, value: "0x0", data: prepared.data }],
    });
    assertWalletUnchanged(expected, await readWalletSession(provider));
    return hash as `0x${string}`;
  } catch (error) {
    throw error;
  }
}

const passkeyCallHashAbi = [{ type: "function", name: "callHash", stateMutability: "view", inputs: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint64" }], outputs: [{ type: "bytes32" }] }] as const;

/** Submit a reviewed management/continuity call through an immutable passkey signer. */
export async function sendPreparedCallWithPasskey(
  provider: EIP1193Provider,
  prepared: PreparedCall,
  expectations: PreparedCallExpectations,
  signerAddress: `0x${string}`,
  sponsor: WalletSession,
  options: PasskeyRequestOptions & { deadline?: number } = {},
): Promise<`0x${string}`> {
  const verification = verifyPreparedCall(prepared, expectations);
  if (!verification.ok) throw new Error(`Prepared transaction rejected: ${verification.reason}`);
  assertWalletUnchanged(sponsor, await readWalletSession(provider));
  const request = provider.request as (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  const nonceRaw = await request({ method: "eth_call", params: [{ to: signerAddress, data: encodePasskeyCallNonce() }, "latest"] });
  const nonceDecoded = decodeFunctionResult({ abi: [{ type: "function", name: "callNonce", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }], functionName: "callNonce", data: nonceRaw as `0x${string}` });
  const nonce = nonceDecoded as bigint;
  const deadline = options.deadline ?? Math.floor(Date.now() / 1000) + 300;
  if (!Number.isSafeInteger(deadline) || deadline <= Math.floor(Date.now() / 1000)) throw new Error("Passkey call deadline is invalid.");
  const call = { signerAddress, chainId: sponsor.chainId, target: prepared.to, value: "0", data: prepared.data, nonce, deadline } as const;
  const digest = hashPasskeyCall(call);
  const onchainHashRaw = await request({ method: "eth_call", params: [{ to: signerAddress, data: encodeFunctionData({ abi: passkeyCallHashAbi, functionName: "callHash", args: [call.target, 0n, call.data, nonce, BigInt(deadline)] }) }, "latest"] });
  const onchainHash = String(decodeFunctionResult({ abi: passkeyCallHashAbi, functionName: "callHash", data: onchainHashRaw as `0x${string}` })).toLowerCase();
  if (onchainHash !== digest.toLowerCase()) throw new Error("Passkey signer returned a mismatched call hash.");
  const assertion = await getPasskeyAssertion(digest, signerAddress, options);
  const executeData = encodePasskeyCall({ ...call, signature: encodePasskeySignature(assertion) });
  await request({ method: "eth_call", params: [{ from: sponsor.account, to: signerAddress, value: "0x0", data: executeData }, "latest"] });
  try {
    const hash = await request({ method: "eth_sendTransaction", params: [{ from: sponsor.account, to: signerAddress, value: "0x0", data: executeData }] });
    assertWalletUnchanged(sponsor, await readWalletSession(provider));
    return hash as `0x${string}`;
  } catch (error) { throw error; }
}

export function assertWalletUnchanged(expected: WalletSession, current: WalletSession): void {
  if (expected.account.toLowerCase() !== current.account.toLowerCase() || expected.chainId !== current.chainId) {
    throw new Error("Wallet account or network changed. Review the action again before signing.");
  }
}

export type SubmissionState = "submitted" | "checking_status" | "included" | "finalized" | "reverted";

export interface SubmissionTracker {
  state: SubmissionState;
  txHash?: `0x${string}`;
  intentId: string;
  message: string;
}

export function unknownSubmission(intentId: string, txHash?: `0x${string}`): SubmissionTracker {
  return { intentId, txHash, state: "checking_status", message: "Submission outcome is unknown. Steward is checking the original intent and hash; it will not resend automatically." };
}
