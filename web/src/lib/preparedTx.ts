import { decodeFunctionData, encodeFunctionData } from "viem";
import { actionKindNumber, hashActionIntent } from "@steward/shared";
import type { ActionIntent, PreparedTransaction } from "../domain";

/** A reviewed call that is safe to show to a wallet after local checks. */
export interface PreparedCall {
  chainId: number;
  to: `0x${string}`;
  value: string;
  data: `0x${string}`;
  manifestVersion: string;
  simulation?: { ok: boolean; reason?: string };
  expiresAt: string;
  /** Optional server-provided hash; management/deployment calls may omit it. */
  actionHash?: `0x${string}`;
}

export interface PreparedCallExpectations {
  chainId: number;
  to: `0x${string}`;
  data?: `0x${string}`;
  manifestVersions?: ReadonlySet<string>;
}

/**
 * Check the complete envelope before handing a non-action call to a wallet.
 * The caller must provide the exact reviewed target and, where it can decode the
 * request locally, the exact canonical calldata. No server-provided target is
 * trusted merely because it arrived in a prepared response.
 */
export function verifyPreparedCall(call: PreparedCall, expected: PreparedCallExpectations): { ok: true } | { ok: false; reason: string } {
  if (call.chainId !== expected.chainId) return { ok: false, reason: "Prepared transaction chain does not match the reviewed request." };
  if (!sameAddress(call.to, expected.to)) return { ok: false, reason: "Prepared transaction destination changed." };
  if (call.value !== "0") return { ok: false, reason: "Prepared transaction sends native value." };
  if (expected.manifestVersions && !expected.manifestVersions.has(call.manifestVersion)) return { ok: false, reason: "Prepared transaction manifest is not approved." };
  if (call.simulation && !call.simulation.ok) return { ok: false, reason: call.simulation.reason ?? "Prepared transaction simulation failed." };
  if (!Number.isFinite(Date.parse(call.expiresAt)) || Date.parse(call.expiresAt) <= Date.now()) return { ok: false, reason: "Prepared transaction has expired." };
  if (expected.data !== undefined && call.data.toLowerCase() !== expected.data.toLowerCase()) return { ok: false, reason: "Prepared calldata changed." };
  if (!/^0x[0-9a-fA-F]*$/.test(call.data)) return { ok: false, reason: "Prepared calldata is not valid hex." };
  return { ok: true };
}

export const SUPPORTED_MANIFEST_VERSIONS = new Set(["demo-1", "steward-account-v1", "STEWARD_ACCOUNT_V1"]);

const ACTION_COMPONENTS = [
  { name: "actionId", type: "bytes32" }, { name: "kind", type: "uint8" }, { name: "account", type: "address" }, { name: "actor", type: "address" },
  { name: "chainId", type: "uint256" }, { name: "securityEpoch", type: "uint256" }, { name: "policyVersion", type: "uint256" }, { name: "nonce", type: "uint256" },
  { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" }, { name: "recipient", type: "address" }, { name: "amountInRaw", type: "uint256" },
  { name: "minAmountOutRaw", type: "uint256" }, { name: "adapter", type: "address" }, { name: "routeHash", type: "bytes32" }, { name: "validAfter", type: "uint64" },
  { name: "deadline", type: "uint64" }, { name: "exceptionMask", type: "uint256" },
] as const;

const PAYMENT_ABI = [{ type: "function", name: "executePayment", stateMutability: "nonpayable", inputs: [{ name: "a", type: "tuple", components: ACTION_COMPONENTS }, { name: "approvals", type: "bytes[]" }], outputs: [{ name: "amountOut", type: "uint256" }] }] as const;
const TRADE_ABI = [{ type: "function", name: "executeTrade", stateMutability: "nonpayable", inputs: [{ name: "a", type: "tuple", components: ACTION_COMPONENTS }, { name: "approvals", type: "bytes[]" }], outputs: [{ name: "amountOut", type: "uint256" }] }] as const;

function actionTuple(intent: ActionIntent) {
  return {
    actionId: intent.actionId, kind: actionKindNumber(intent.kind), account: intent.account, actor: intent.actor,
    chainId: BigInt(intent.chainId), securityEpoch: BigInt(intent.securityEpoch), policyVersion: BigInt(intent.policyVersion), nonce: BigInt(intent.nonce),
    tokenIn: intent.tokenIn, tokenOut: intent.tokenOut, recipient: intent.recipient, amountInRaw: BigInt(intent.amountInRaw), minAmountOutRaw: BigInt(intent.minAmountOutRaw),
    adapter: intent.adapter, routeHash: intent.routeHash, validAfter: BigInt(intent.validAfter), deadline: BigInt(intent.deadline), exceptionMask: BigInt(intent.exceptionMask),
  };
}

export function actionHashFromIntent(intent: ActionIntent): `0x${string}` { return hashActionIntent(intent); }

/** Encode only the reviewed account entry point; callers still need server approvals. */
export function encodeSupportedAction(intent: ActionIntent): `0x${string}` {
  const abi = intent.kind === "PAYMENT" ? PAYMENT_ABI : TRADE_ABI;
  const functionName = intent.kind === "PAYMENT" ? "executePayment" : "executeTrade";
  return encodeFunctionData({ abi, functionName, args: [actionTuple(intent), []] }) as `0x${string}`;
}

function sameAddress(a: string, b: string) { return a.toLowerCase() === b.toLowerCase(); }

function verifyDecodedAction(intent: ActionIntent, decoded: ReturnType<typeof decodeFunctionData>): string | undefined {
  const [raw] = decoded.args as readonly [Record<string, unknown>, readonly string[]];
  if (!raw || typeof raw !== "object") return "Prepared calldata has no action tuple.";
  const expected = actionTuple(intent) as Record<string, unknown>;
  const addressFields = ["account", "actor", "tokenIn", "tokenOut", "recipient", "adapter"];
  for (const field of addressFields) if (!sameAddress(String(raw[field]), String(expected[field]))) return `Calldata ${field} changed.`;
  const numericFields = ["kind", "chainId", "securityEpoch", "policyVersion", "nonce", "amountInRaw", "minAmountOutRaw", "validAfter", "deadline", "exceptionMask"];
  for (const field of numericFields) if (BigInt(String(raw[field])) !== BigInt(String(expected[field]))) return `Calldata ${field} changed.`;
  if (String(raw.actionId).toLowerCase() !== intent.actionId.toLowerCase() || String(raw.routeHash).toLowerCase() !== intent.routeHash.toLowerCase()) return "Calldata action hash or route changed.";
  return undefined;
}

export function verifyPreparedTransaction(intent: ActionIntent, prepared: PreparedTransaction): { ok: true } | { ok: false; reason: string } {
  if (!( ["PAYMENT", "BUY", "SELL"] as string[]).includes(intent.kind)) return { ok: false, reason: "Unsupported action kind." };
  if (prepared.chainId !== intent.chainId) return { ok: false, reason: "Prepared transaction chain does not match the action." };
  if (!sameAddress(prepared.to, intent.account)) return { ok: false, reason: "Prepared transaction destination is not the Steward account." };
  if (prepared.value !== "0") return { ok: false, reason: "Prepared transaction sends native value." };
  if (!SUPPORTED_MANIFEST_VERSIONS.has(prepared.manifestVersion)) return { ok: false, reason: "Unsupported transaction manifest." };
  if (!prepared.simulation.ok) return { ok: false, reason: prepared.simulation.reason ?? "Simulation failed." };
  if (!Number.isFinite(Date.parse(prepared.expiresAt)) || Date.parse(prepared.expiresAt) <= Date.now()) return { ok: false, reason: "Prepared transaction has expired." };
  if (!sameAddress(prepared.actionHash, hashActionIntent(intent))) return { ok: false, reason: "Prepared action hash does not match the reviewed action." };
  const abi = intent.kind === "PAYMENT" ? PAYMENT_ABI : TRADE_ABI;
  const functionName = intent.kind === "PAYMENT" ? "executePayment" : "executeTrade";
  let decoded: ReturnType<typeof decodeFunctionData>;
  try {
    decoded = decodeFunctionData({ abi, data: prepared.data as `0x${string}` });
  } catch { return { ok: false, reason: "Prepared calldata is not a supported Steward method." }; }
  if (decoded.functionName !== functionName) return { ok: false, reason: "Prepared method does not match the action kind." };
  const fieldError = verifyDecodedAction(intent, decoded);
  if (fieldError) return { ok: false, reason: fieldError };
  if (encodeFunctionData({ abi, functionName, args: decoded.args as never }) !== prepared.data) return { ok: false, reason: "Prepared calldata is not canonical." };
  return { ok: true };
}
