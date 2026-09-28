import { hashTypedData, keccak256, encodeFunctionData } from 'viem'
import { z } from 'zod'
export {expectedV2ShellRuntimeCode,expectedV2ShellRuntimeCodeHash} from './v2Shell'
export {COW_KIND_SELL,COW_BALANCE_ERC20,CowOrderSchema,contractCowOrder,cowOrderDigest,V2_COW_ORDER_ABI} from './v2Orders'
export type {CowOrderInput,CowOrder} from './v2Orders'

export const AddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'invalid EVM address').transform((v) => v.toLowerCase() as `0x${string}`)
export const Bytes32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'invalid bytes32').transform((v) => v.toLowerCase() as `0x${string}`)
export const UIntStringSchema = z.string().regex(/^(0|[1-9][0-9]*)$/, 'must be an unsigned integer string')
export const UInt256Schema = UIntStringSchema.refine((v) => BigInt(v) <= ((1n << 256n) - 1n), 'uint256 overflow')
export const UInt64Schema = UIntStringSchema.refine((v) => BigInt(v) <= ((1n << 64n) - 1n), 'uint64 overflow')

const HexDataSchema = z.string().regex(/^0x[0-9a-fA-F]*$/, 'invalid hex data')

export const ActionKindSchema = z.enum(['PAYMENT', 'BUY', 'SELL'])
export type ActionKind = z.infer<typeof ActionKindSchema>

export const ActionIntentSchema = z.object({
  actionId: Bytes32Schema,
  kind: ActionKindSchema,
  account: AddressSchema,
  actor: AddressSchema,
  chainId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  securityEpoch: UInt256Schema,
  policyVersion: UInt256Schema,
  nonce: UInt256Schema,
  tokenIn: AddressSchema,
  tokenOut: AddressSchema,
  recipient: AddressSchema,
  amountInRaw: UInt256Schema,
  minAmountOutRaw: UInt256Schema,
  adapter: AddressSchema,
  routeHash: Bytes32Schema,
  validAfter: UInt64Schema,
  deadline: UInt64Schema,
  exceptionMask: UInt256Schema,
}).superRefine((v, ctx) => {
  if (BigInt(v.deadline) < BigInt(v.validAfter)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['deadline'], message: 'deadline precedes validAfter' })
  if (v.kind === 'PAYMENT' && v.tokenOut !== ZERO_ADDRESS) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tokenOut'], message: 'payment tokenOut must be zero address' })
  if (v.kind === 'PAYMENT' && v.adapter !== ZERO_ADDRESS) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['adapter'], message: 'payment adapter must be zero address' })
  if ((v.kind === 'BUY' || v.kind === 'SELL') && v.recipient !== v.account) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['recipient'], message: 'trade recipient must be account' })
})
export type ActionIntent = z.infer<typeof ActionIntentSchema>

export const AccountSnapshotSchema = z.object({
  id: z.string().min(1),
  address: AddressSchema,
  chainId: z.number().int().positive(),
  parent: AddressSchema,
  role: z.enum(['parent', 'caregiver', 'cosigner', 'viewer']),
  policyVersion: UInt256Schema,
  securityEpoch: UInt256Schema,
  snapshotBlock: UInt256Schema,
  indexFreshness: z.enum(['fresh', 'catching_up', 'stale', 'unavailable']),
  settlementReserveRaw: UInt256Schema,
  totalValueRaw: UInt256Schema,
})
export type AccountSnapshot = z.infer<typeof AccountSnapshotSchema>

export const AssetDescriptorSchema = z.object({
  id: z.string().min(1), provider: z.string().min(1), chainId: z.number().int().positive(), address: AddressSchema,
  symbol: z.string().min(1).max(32), name: z.string().min(1).max(200), decimals: z.number().int().min(0).max(255),
  legalInstrumentType: z.string().min(1), sourceTermsVersion: z.string().min(1), capabilities: z.array(z.enum(['buy', 'sell', 'payment'])),
  admission: z.enum(['allowed', 'blocked', 'review_required', 'unknown']), admissionReason: z.string().optional(),
})
export type AssetDescriptor = z.infer<typeof AssetDescriptorSchema>

export const BudgetViewSchema = z.object({ limitRaw: UInt256Schema, spentRaw: UInt256Schema, remainingRaw: UInt256Schema, unit: z.string().min(1), period: z.enum(['daily', 'weekly', 'fixed']), resetAt: z.string().datetime(), pendingRequests: z.number().int().nonnegative(), buyBudget: z.object({ limitRaw: UInt256Schema, chargedRaw: UInt256Schema, pendingRaw: UInt256Schema, availableRaw: UInt256Schema }).optional() })
export type BudgetView = z.infer<typeof BudgetViewSchema>

export const PreparedTransactionSchema = z.object({
  chainId: z.number().int().positive(), to: AddressSchema, value: UInt256Schema, data: HexDataSchema,
  actionHash: Bytes32Schema, manifestVersion: z.string().min(1), simulation: z.object({ ok: z.boolean(), reason: z.string().optional() }), expiresAt: z.string().datetime(),
})
export type PreparedTransaction = z.infer<typeof PreparedTransactionSchema>

export const ApprovalViewSchema = z.object({ signer: AddressSchema, actionHash: Bytes32Schema, signature: HexDataSchema, signatureType: z.enum(['eoa', 'erc1271', 'passkey']), createdAt: z.string().datetime() })
export type ApprovalView = z.infer<typeof ApprovalViewSchema>

export const ActivityItemSchema = z.object({ id: z.string(), accountId: z.string(), kind: z.string(), state: z.string(), createdAt: z.string().datetime(), actor: AddressSchema.optional(), actionHash: Bytes32Schema.optional(), transactionHash: Bytes32Schema.optional(), summary: z.string().max(500) })
export type ActivityItem = z.infer<typeof ActivityItemSchema>

export const ContinuityCaseSchema = z.object({
  id: z.string(), accountId: z.string(), type: z.enum(['recovery', 'incapacity', 'succession']),
  state: z.enum(['requested', 'evidence_pending', 'under_review', 'approved', 'challenge_window', 'executable', 'executed', 'challenged', 'rejected', 'cancelled', 'expired']),
  successor: AddressSchema.optional(), planVersion: UInt256Schema, chainCaseId:UInt256Schema.optional(), requestTransactionHash:Bytes32Schema.optional(), executionTransactionHash:Bytes32Schema.optional(), reviewMessage:z.string().optional(), deadline: z.string().datetime().optional(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
})
export type ContinuityCase = z.infer<typeof ContinuityCaseSchema>

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const
export const ACTION_TYPES = {
  Action: [
    { name: 'actionId', type: 'bytes32' }, { name: 'kind', type: 'uint8' }, { name: 'account', type: 'address' }, { name: 'actor', type: 'address' },
    { name: 'chainId', type: 'uint256' }, { name: 'securityEpoch', type: 'uint256' }, { name: 'policyVersion', type: 'uint256' }, { name: 'nonce', type: 'uint256' },
    { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' }, { name: 'recipient', type: 'address' }, { name: 'amountInRaw', type: 'uint256' },
    { name: 'minAmountOutRaw', type: 'uint256' }, { name: 'adapter', type: 'address' }, { name: 'routeHash', type: 'bytes32' }, { name: 'validAfter', type: 'uint64' },
    { name: 'deadline', type: 'uint64' }, { name: 'exceptionMask', type: 'uint256' },
  ],
} as const

export function actionMessage(action: ActionIntent) {
  return {
    actionId: action.actionId, kind: action.kind === 'PAYMENT' ? 0 : action.kind === 'BUY' ? 1 : 2, account: action.account, actor: action.actor,
    chainId: BigInt(action.chainId), securityEpoch: BigInt(action.securityEpoch), policyVersion: BigInt(action.policyVersion), nonce: BigInt(action.nonce),
    tokenIn: action.tokenIn, tokenOut: action.tokenOut, recipient: action.recipient, amountInRaw: BigInt(action.amountInRaw), minAmountOutRaw: BigInt(action.minAmountOutRaw),
    adapter: action.adapter, routeHash: action.routeHash, validAfter: BigInt(action.validAfter), deadline: BigInt(action.deadline), exceptionMask: BigInt(action.exceptionMask),
  } as const
}

export function actionDomain(action: Pick<ActionIntent, 'chainId' | 'account'>) { return { name: 'Steward', version: '1', chainId: action.chainId, verifyingContract: action.account } as const }
export function hashActionIntent(action: ActionIntent): `0x${string}` { return hashTypedData({ domain: actionDomain(action), types: ACTION_TYPES, primaryType: 'Action', message: actionMessage(action) }) }
export function actionKindNumber(kind: ActionKind) { return kind === 'PAYMENT' ? 0 : kind === 'BUY' ? 1 : 2 }

export function randomBytes32(): `0x${string}` {
  const bytes = new Uint8Array(32); crypto.getRandomValues(bytes); return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
}

export const ACTION_COMPONENTS = [
  { name: 'actionId', type: 'bytes32' }, { name: 'kind', type: 'uint8' }, { name: 'account', type: 'address' }, { name: 'actor', type: 'address' },
  { name: 'chainId', type: 'uint256' }, { name: 'securityEpoch', type: 'uint256' }, { name: 'policyVersion', type: 'uint256' }, { name: 'nonce', type: 'uint256' },
  { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' }, { name: 'recipient', type: 'address' }, { name: 'amountInRaw', type: 'uint256' },
  { name: 'minAmountOutRaw', type: 'uint256' }, { name: 'adapter', type: 'address' }, { name: 'routeHash', type: 'bytes32' }, { name: 'validAfter', type: 'uint64' },
  { name: 'deadline', type: 'uint64' }, { name: 'exceptionMask', type: 'uint256' },
] as const

export function encodeActionForContract(action: ActionIntent, signatures: `0x${string}`[] = []): `0x${string}` {
  const tuple = [action.actionId, actionKindNumber(action.kind), action.account, action.actor, BigInt(action.chainId), BigInt(action.securityEpoch), BigInt(action.policyVersion), BigInt(action.nonce), action.tokenIn, action.tokenOut, action.recipient, BigInt(action.amountInRaw), BigInt(action.minAmountOutRaw), action.adapter, action.routeHash, BigInt(action.validAfter), BigInt(action.deadline), BigInt(action.exceptionMask)] as const
  const name = action.kind === 'PAYMENT' ? 'executePayment' : 'executeTrade'
  return encodeFunctionData({ abi: [{ type: 'function', name, stateMutability: 'nonpayable', inputs: [{ name: 'action', type: 'tuple', components: ACTION_COMPONENTS }, { name: 'approvals', type: 'bytes[]' }], outputs: [] }], functionName: name, args: [tuple, signatures] } as any)
}

export const ApiErrorSchema = z.object({ code: z.string(), message: z.string(), retryable: z.boolean(), nextAction: z.string().optional() })
export const ApiEnvelopeSchema = z.object({ data: z.unknown().optional(), error: ApiErrorSchema.optional(), requestId: z.string(), observedAt: z.string(), snapshotBlock: UInt256Schema.optional(), policyVersion: UInt256Schema.optional(), warnings: z.array(z.string()).optional() })
export type ApiEnvelope<T> = { data: T; requestId: string; observedAt: string; snapshotBlock?: string; policyVersion?: string; warnings?: string[] }

export { keccak256 }
