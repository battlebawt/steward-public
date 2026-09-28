import { decodeFunctionData, encodeFunctionData, type Hex } from "viem";

const address = (value: unknown, field: string): `0x${string}` => {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${field} must be an EVM address.`);
  return value.toLowerCase() as `0x${string}`;
};
const bytes32 = (value: unknown, field: string): `0x${string}` => {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${field} must be bytes32.`);
  return value.toLowerCase() as `0x${string}`;
};
const uint = (value: unknown, field: string): bigint => {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") throw new Error(`${field} must be an unsigned integer.`);
  const text = String(value); if (!/^(0|[1-9][0-9]*)$/.test(text)) throw new Error(`${field} must be an unsigned integer.`);
  return BigInt(text);
};

const POLICY_COMPONENTS = [
  { name: "settlement", type: "address" }, { name: "period", type: "uint64" }, { name: "anchor", type: "uint64" },
  { name: "paymentLimit", type: "uint256" }, { name: "buyLimit", type: "uint256" }, { name: "reserve", type: "uint256" },
  { name: "perPayment", type: "uint256" }, { name: "perBuy", type: "uint256" }, { name: "perSell", type: "uint256" }, { name: "exceptionQuorum", type: "uint256" },
  { name: "approvedTokens", type: "address[]" }, { name: "paymentRecipients", type: "address[]" }, { name: "exceptionSigners", type: "address[]" },
  { name: "guardians", type: "address[]" }, { name: "approvedAdapters", type: "address[]" }, { name: "sellCapTokens", type: "address[]" },
  { name: "sellCaps", type: "uint256[]" }, { name: "continuityReviewer", type: "address" }, { name: "continuitySuccessor", type: "address" }, { name: "continuityPlanHash", type: "bytes32" },
] as const;
const accountAbi = [
  { type: "function", name: "tightenPolicy", stateMutability: "nonpayable", inputs: [{ name: "next", type: "tuple", components: POLICY_COMPONENTS }], outputs: [] },
  { type: "function", name: "queuePolicyExpansion", stateMutability: "nonpayable", inputs: [{ name: "commitment", type: "bytes32" }], outputs: [] },
  { type: "function", name: "executePolicyExpansion", stateMutability: "nonpayable", inputs: [{ name: "next", type: "tuple", components: POLICY_COMPONENTS }, { name: "salt", type: "bytes32" }], outputs: [] },
  { type: "function", name: "cancelPolicyExpansion", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "executeAdapterAdmission", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "executeIncapacityModule", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "deactivateIncapacity", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "pauseDelegatedSpending", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "unpauseDelegatedSpending", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "setDelegate", stateMutability: "nonpayable", inputs: [{ name: "delegate", type: "address" }, { name: "actionMask", type: "uint256" }, { name: "expiresAt", type: "uint64" }, { name: "perActionLimit", type: "uint256" }], outputs: [] },
  { type: "function", name: "revokeDelegate", stateMutability: "nonpayable", inputs: [{ name: "delegate", type: "address" }], outputs: [] },
  { type: "function", name: "queueIncapacityModule", stateMutability: "nonpayable", inputs: [{ name: "module", type: "address" }, { name: "caregiver", type: "address" }, { name: "actionMask", type: "uint256" }, { name: "perActionLimit", type: "uint256" }], outputs: [] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }, { name: "to", type: "address" }], outputs: [] },
  { type: "function", name: "admitAdapter", stateMutability: "nonpayable", inputs: [{ name: "adapter", type: "address" }, { name: "enabled", type: "bool" }], outputs: [] },
] as const;

function policyConfig(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A complete policy configuration is required.");
  const p = value as Record<string, unknown>;
  const addresses = (field: string) => { const v = p[field]; if (!Array.isArray(v)) throw new Error(`${field} must be an array.`); return v.map((x) => address(x, field)); };
  const sellCaps = p.sellCaps; if (!Array.isArray(sellCaps)) throw new Error("sellCaps must be an array.");
  const sellCapTokens = addresses("sellCapTokens"); if (sellCapTokens.length !== sellCaps.length) throw new Error("sellCaps must match sellCapTokens.");
  return {
    settlement: address(p.settlement, "settlement"), period: uint(p.period, "period"), anchor: uint(p.anchor, "anchor"), paymentLimit: uint(p.paymentLimit, "paymentLimit"), buyLimit: uint(p.buyLimit, "buyLimit"), reserve: uint(p.reserve, "reserve"), perPayment: uint(p.perPayment, "perPayment"), perBuy: uint(p.perBuy, "perBuy"), perSell: uint(p.perSell, "perSell"), exceptionQuorum: uint(p.exceptionQuorum, "exceptionQuorum"),
    approvedTokens: addresses("approvedTokens"), paymentRecipients: addresses("paymentRecipients"), exceptionSigners: addresses("exceptionSigners"), guardians: addresses("guardians"), approvedAdapters: addresses("approvedAdapters"), sellCapTokens, sellCaps: sellCaps.map((x) => uint(x, "sellCaps")), continuityReviewer: address(p.continuityReviewer, "continuityReviewer"), continuitySuccessor: address(p.continuitySuccessor, "continuitySuccessor"), continuityPlanHash: bytes32(p.continuityPlanHash, "continuityPlanHash"),
  };
}

/** Encode only reviewed account-management operations. */
export function encodeManagementCall(input: unknown): Hex {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Management request must be an object.");
  const p = input as Record<string, unknown>; const operation = p.operation;
  switch (operation) {
    case "tightenPolicy": return encodeFunctionData({ abi: accountAbi, functionName: operation, args: [policyConfig(p.policy)] });
    case "queuePolicyExpansion": return encodeFunctionData({ abi: accountAbi, functionName: operation, args: [bytes32(p.commitment, "commitment")] });
    case "executePolicyExpansion": return encodeFunctionData({ abi: accountAbi, functionName: operation, args: [policyConfig(p.policy), bytes32(p.salt, "salt")] });
    case "cancelPolicyExpansion": return encodeFunctionData({ abi: accountAbi, functionName: operation, args: [] });
    case "executeAdapterAdmission": case "executeIncapacityModule": case "deactivateIncapacity": case "pauseDelegatedSpending": case "unpauseDelegatedSpending": return encodeFunctionData({ abi: accountAbi, functionName: operation, args: [] });
    case "setDelegate": return encodeFunctionData({ abi: accountAbi, functionName: operation, args: [address(p.delegate, "delegate"), uint(p.actionMask, "actionMask"), uint(p.expiresAt, "expiresAt"), uint(p.perActionLimit, "perActionLimit")] });
    case "revokeDelegate": return encodeFunctionData({ abi: accountAbi, functionName: operation, args: [address(p.delegate, "delegate")] });
    case "queueIncapacityModule": return encodeFunctionData({ abi: accountAbi, functionName: operation, args: [address(p.module, "module"), address(p.caregiver, "caregiver"), uint(p.actionMask, "actionMask"), uint(p.perActionLimit, "perActionLimit")] });
    case "withdraw": return encodeFunctionData({ abi: accountAbi, functionName: operation, args: [address(p.token, "token"), uint(p.amount, "amount"), address(p.recipient, "recipient")] });
    case "admitAdapter": if (typeof p.enabled !== "boolean") throw new Error("enabled must be boolean."); return encodeFunctionData({ abi: accountAbi, functionName: operation, args: [address(p.adapter, "adapter"), p.enabled] });
    default: throw new Error("Unsupported management operation.");
  }
}

/** Decode and re-encode a prepared management call to enforce canonical ABI bytes. */
export function verifyManagementCalldata(input: unknown, data: Hex): { ok: true; operation: string } | { ok: false; reason: string } {
  try {
    const expected = encodeManagementCall(input);
    if (expected.toLowerCase() !== data.toLowerCase()) return { ok: false, reason: "Prepared management calldata changed." };
    const decoded = decodeFunctionData({ abi: accountAbi, data });
    return { ok: true, operation: String(decoded.functionName) };
  } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : "Prepared management calldata is invalid." }; }
}

const factoryAbi = [{ type: "function", name: "createAccount", stateMutability: "nonpayable", inputs: [{ name: "parent", type: "address" }, { name: "config", type: "tuple", components: POLICY_COMPONENTS }], outputs: [{ name: "account", type: "address" }] }] as const;

/** Encode the reviewed factory deployment request for independent client comparison. */
export function encodeDeploymentCall(parent: `0x${string}`, policy: unknown): Hex {
  return encodeFunctionData({ abi: factoryAbi, functionName: "createAccount", args: [address(parent, "parent"), policyConfig(policy)] });
}

const continuityAbi = [
  { type: "function", name: "startRecovery", stateMutability: "nonpayable", inputs: [{ name: "newParent", type: "address" }], outputs: [] },
  { type: "function", name: "approveRecovery", stateMutability: "nonpayable", inputs: [{ name: "id", type: "uint256" }], outputs: [] },
  { type: "function", name: "cancelRecovery", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "cancelSuccession", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "executeRecovery", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "requestSuccession", stateMutability: "nonpayable", inputs: [{ name: "successor", type: "address" }, { name: "reviewer", type: "address" }, { name: "planHash", type: "bytes32" }, { name: "evidenceHash", type: "bytes32" }, { name: "deadline", type: "uint64" }], outputs: [] },
  { type: "function", name: "approveSuccession", stateMutability: "nonpayable", inputs: [{ name: "id", type: "uint256" }, { name: "reviewerSignature", type: "bytes" }], outputs: [] },
  { type: "function", name: "acceptSuccession", stateMutability: "nonpayable", inputs: [{ name: "id", type: "uint256" }, { name: "successorSignature", type: "bytes" }], outputs: [] },
  { type: "function", name: "challengeSuccession", stateMutability: "nonpayable", inputs: [{ name: "id", type: "uint256" }], outputs: [] },
  { type: "function", name: "resolveSuccession", stateMutability: "nonpayable", inputs: [{ name: "id", type: "uint256" }, { name: "approved", type: "bool" }], outputs: [] },
  { type: "function", name: "executeSuccession", stateMutability: "nonpayable", inputs: [{ name: "id", type: "uint256" }, { name: "planHash", type: "bytes32" }, { name: "evidenceHash", type: "bytes32" }], outputs: [] },
] as const;

const incapacityAbi = [
  { type: "function", name: "request", stateMutability: "nonpayable", inputs: [{ name: "evidenceHash", type: "bytes32" }, { name: "deadline", type: "uint64" }], outputs: [{ name: "id", type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "id", type: "uint256" }, { name: "reviewerSignature", type: "bytes" }], outputs: [] },
  { type: "function", name: "challenge", stateMutability: "nonpayable", inputs: [{ name: "id", type: "uint256" }], outputs: [] },
  { type: "function", name: "resolve", stateMutability: "nonpayable", inputs: [{ name: "id", type: "uint256" }, { name: "approved", type: "bool" }], outputs: [] },
  { type: "function", name: "cancel", stateMutability: "nonpayable", inputs: [{ name: "id", type: "uint256" }], outputs: [] },
  { type: "function", name: "expire", stateMutability: "nonpayable", inputs: [{ name: "id", type: "uint256" }], outputs: [] },
  { type: "function", name: "execute", stateMutability: "nonpayable", inputs: [{ name: "id", type: "uint256" }], outputs: [] },
] as const;

function hexBytes(value: unknown, field: string): Hex { if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) throw new Error(`${field} must be hex bytes.`); return value as Hex; }
function continuityUsesIncapacity(operation: unknown) { return typeof operation === "string" && operation.endsWith("Incapacity"); }

export function encodeContinuityCall(input: unknown): Hex {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Continuity request must be an object.");
  const p = input as Record<string, unknown>; const operation = p.operation;
  switch (operation) {
    case "startRecovery": return encodeFunctionData({ abi: continuityAbi, functionName: operation, args: [address(p.successor, "successor")] });
    case "approveRecovery": case "cancelRecovery": case "executeRecovery": case "cancelSuccession": case "challengeSuccession": return encodeFunctionData({ abi: continuityAbi, functionName: operation, args: operation === "cancelRecovery" || operation === "executeRecovery" || operation === "cancelSuccession" ? [] : [uint(p.id, "id")] });
    case "requestSuccession": return encodeFunctionData({ abi: continuityAbi, functionName: operation, args: [address(p.successor, "successor"), address(p.reviewer, "reviewer"), bytes32(p.planHash, "planHash"), bytes32(p.evidenceHash, "evidenceHash"), uint(p.deadline, "deadline")] });
    case "approveSuccession": return encodeFunctionData({ abi: continuityAbi, functionName: operation, args: [uint(p.id, "id"), hexBytes(p.signature, "signature")] });
    case "acceptSuccession": return encodeFunctionData({ abi: continuityAbi, functionName: operation, args: [uint(p.id, "id"), hexBytes(p.signature, "signature")] });
    case "resolveSuccession": if (typeof p.approved !== "boolean") throw new Error("approved must be boolean."); return encodeFunctionData({ abi: continuityAbi, functionName: operation, args: [uint(p.id, "id"), p.approved] });
    case "executeSuccession": return encodeFunctionData({ abi: continuityAbi, functionName: operation, args: [uint(p.id, "id"), bytes32(p.planHash, "planHash"), bytes32(p.evidenceHash, "evidenceHash")] });
    case "requestIncapacity": return encodeFunctionData({ abi: incapacityAbi, functionName: "request", args: [bytes32(p.evidenceHash, "evidenceHash"), uint(p.deadline, "deadline")] });
    case "approveIncapacity": return encodeFunctionData({ abi: incapacityAbi, functionName: "approve", args: [uint(p.id, "id"), hexBytes(p.signature, "signature")] });
    case "resolveIncapacity": return encodeFunctionData({ abi: incapacityAbi, functionName: "resolve", args: [uint(p.id, "id"), typeof p.approved === "boolean" ? p.approved : (() => { throw new Error("approved must be boolean."); })()] });
    case "challengeIncapacity": return encodeFunctionData({ abi: incapacityAbi, functionName: "challenge", args: [uint(p.id, "id")] });
    case "cancelIncapacity": return encodeFunctionData({ abi: incapacityAbi, functionName: "cancel", args: [uint(p.id, "id")] });
    case "expireIncapacity": return encodeFunctionData({ abi: incapacityAbi, functionName: "expire", args: [uint(p.id, "id")] });
    case "executeIncapacity": return encodeFunctionData({ abi: incapacityAbi, functionName: "execute", args: [uint(p.id, "id")] });
    default: throw new Error("Unsupported continuity operation.");
  }
}

export function verifyContinuityCalldata(input: unknown, data: Hex): { ok: true; operation: string } | { ok: false; reason: string } {
  try {
    const expected = encodeContinuityCall(input); if (expected.toLowerCase() !== data.toLowerCase()) return { ok: false, reason: "Prepared continuity calldata changed." };
    const operation = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>).operation : undefined;
    const decoded = decodeFunctionData({ abi: continuityUsesIncapacity(operation) ? incapacityAbi : continuityAbi, data });
    return { ok: true, operation: String(decoded.functionName) };
  } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : "Prepared continuity calldata is invalid." }; }
}
