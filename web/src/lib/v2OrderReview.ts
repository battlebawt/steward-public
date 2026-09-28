import { decodeFunctionData, encodeFunctionData, recoverTypedDataAddress, type Address, type Hex } from 'viem'
import { ACTION_TYPES, ActionIntentSchema, CowOrderSchema, V2_COW_ORDER_ABI, actionDomain, actionMessage, contractCowOrder, cowOrderDigest, hashActionIntent } from '@steward/shared'
import type { ActionIntent, CowOrderInput } from '@steward/shared'
import type { PreparedTransaction } from '../domain'
import { verifyPreparedCall } from './preparedTx'

export type LocalV2Context = { chainId: number; account: Address; parent: Address; settlementToken: Address; stockToken: Address; cowSettlement: Address; settlementSymbol: string; stockSymbol: string; settlementDecimals: number; stockDecimals: number; policyVersion: string; securityEpoch: string; periodEnd: string; maxFeeBps: string; exceptionSigners: Address[]; exceptionQuorum: number; manifestVersion: string }
export type LocalV2Order = { digest: Hex; order: CowOrderInput; action: ActionIntent; actionHash: Hex; approvals: Array<{ signer: Address; createdAt: string }>; attempts?: Array<{ hash: Hex; operation: 'open' | 'cancel' | 'reconcile'; outcome: 'confirmed' | 'reverted'; observedAt: string }>; prepared: boolean; openTransactionHash: Hex | null; closeTransactionHash: Hex | null; closeOperation: 'cancel' | 'reconcile' | null; status: { state: 'unknown' | 'pending' | 'fill_observed' | 'filled' | 'cancelled' | 'expired_unresolved'; fillEvidenceRaw?: string; sellBudget?: { limitRaw: string; chargedRaw: string; pendingRaw: string; availableRaw: string } }; venue: 'local_fixture_only' }

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const maxUint = (1n << 256n) - 1n

/** Independently bind the server's saved order, typed action and displayed identity before any wallet prompt. */
export function validateLocalV2Order(context: LocalV2Context, orderInput: CowOrderInput, actionInput: ActionIntent, displayedDigest: Hex, displayedActionHash: Hex, allowStaleClose = false) {
  const order = CowOrderSchema.parse(orderInput), action = ActionIntentSchema.parse(actionInput)
  const digest = cowOrderDigest(order, context.chainId, context.cowSettlement)
  const buy = same(order.sellToken, context.settlementToken) && same(order.buyToken, context.stockToken)
  const sell = same(order.sellToken, context.stockToken) && same(order.buyToken, context.settlementToken)
  const gross = BigInt(order.sellAmount) + BigInt(order.feeAmount)
  const now = BigInt(Math.floor(Date.now() / 1000))
  if (!buy && !sell) throw Error('Order token pair changed.')
  if (!same(displayedDigest, digest) || !same(displayedActionHash, hashActionIntent(action))) throw Error('Saved order identity changed.')
  if (BigInt(order.sellAmount) === 0n || BigInt(order.buyAmount) === 0n || gross > maxUint || BigInt(order.feeAmount) * 10000n > BigInt(order.sellAmount) * BigInt(context.maxFeeBps) || (!allowStaleClose && (BigInt(order.validTo) <= now || BigInt(order.validTo) >= BigInt(context.periodEnd)))) throw Error('Order amounts, fee or expiry are outside the current limits.')
  if (!same(order.receiver, context.account) || !same(action.account, context.account) || action.chainId !== context.chainId || action.kind !== (buy ? 'BUY' : 'SELL') || !same(action.actionId, digest) || !same(action.routeHash, digest) || !same(action.tokenIn, order.sellToken) || !same(action.tokenOut, order.buyToken) || !same(action.recipient, context.account) || action.amountInRaw !== gross.toString() || action.minAmountOutRaw !== order.buyAmount || !same(action.adapter, context.cowSettlement) || action.deadline !== order.validTo || (!allowStaleClose && (BigInt(action.validAfter) > now || action.policyVersion !== context.policyVersion || action.securityEpoch !== context.securityEpoch))) throw Error('Saved action does not match this order or current account policy.')
  const mask = BigInt(action.exceptionMask)
  if (!Array.isArray(context.exceptionSigners) || context.exceptionSigners.length > 31 || !Number.isInteger(context.exceptionQuorum) || context.exceptionQuorum < 0 || context.exceptionQuorum > context.exceptionSigners.length) throw Error('Exception signer policy is invalid.')
  if (mask > 1n) {
    if ((mask & 1n) !== 0n || (mask >> BigInt(context.exceptionSigners.length + 1)) !== 0n) throw Error('Exception approval selection changed.')
    let count = 0
    for (let i = 0; i < context.exceptionSigners.length; i++) if ((mask & (1n << BigInt(i + 1))) !== 0n) {
      if (same(context.exceptionSigners[i]!, action.actor)) throw Error('Requester cannot approve their own exception.')
      count++
    }
    if (count < context.exceptionQuorum) throw Error('Exception approval quorum is incomplete.')
  }
  return { order, action, digest }
}

export function assertLocalV2Signer(context: LocalV2Context, action: ActionIntent, wallet: Address, onchainParent: Address, onchainSigners: readonly Address[]) {
  if (!same(onchainParent, context.parent) || onchainSigners.length !== context.exceptionSigners.length || onchainSigners.some((signer, i) => !same(signer, context.exceptionSigners[i]!))) throw Error('Account approvers changed on chain; refresh before signing.')
  const mask = BigInt(action.exceptionMask)
  if (same(wallet, action.actor)) return
  if (mask === 1n && same(wallet, onchainParent)) return
  if (mask > 1n && onchainSigners.some((signer, i) => same(wallet, signer) && (mask & (1n << BigInt(i + 1))) !== 0n)) return
  throw Error('This wallet is not required for the selected order approval.')
}

function exactAction(raw: Record<string, unknown>, action: ActionIntent) {
  const expected = actionMessage(action) as Record<string, unknown>
  for (const key of Object.keys(expected)) {
    if (typeof expected[key] === 'string' && String(expected[key]).startsWith('0x')) {
      if (String(raw[key]).toLowerCase() !== String(expected[key]).toLowerCase()) throw Error(`Prepared action ${key} changed.`)
    } else if (BigInt(String(raw[key])) !== BigInt(String(expected[key]))) throw Error(`Prepared action ${key} changed.`)
  }
}

export async function verifyLocalV2Open(prepared: PreparedTransaction, context: LocalV2Context, orderInput: CowOrderInput, actionInput: ActionIntent, approvedSigners: Address[]) {
  const {order,action,digest} = validateLocalV2Order(context, orderInput, actionInput, cowOrderDigest(orderInput, context.chainId, context.cowSettlement), prepared.actionHash as Hex)
  const envelope = verifyPreparedCall({ ...prepared, data: prepared.data as Hex }, { chainId: context.chainId, to: context.account, manifestVersions: new Set([context.manifestVersion]) })
  if (!envelope.ok) throw Error(envelope.reason)
  const decoded = decodeFunctionData({ abi: V2_COW_ORDER_ABI, data: prepared.data as Hex })
  if (decoded.functionName !== 'openOrder') throw Error('Prepared method is not openOrder.')
  const [rawOrder, rawAction, signatures] = decoded.args
  const received = CowOrderSchema.parse({ ...rawOrder, sellAmount: rawOrder.sellAmount.toString(), buyAmount: rawOrder.buyAmount.toString(), validTo: rawOrder.validTo.toString(), feeAmount: rawOrder.feeAmount.toString() })
  if (JSON.stringify(received) !== JSON.stringify(order)) throw Error('Prepared order fields changed.')
  exactAction(rawAction, action)
  if (encodeFunctionData({ abi: V2_COW_ORDER_ABI, functionName: 'openOrder', args: [contractCowOrder(order), actionMessage(action), signatures] }).toLowerCase() !== prepared.data.toLowerCase()) throw Error('Prepared order calldata is not canonical.')
  const expected = new Set(approvedSigners.map(v => v.toLowerCase()))
  if (signatures.length !== expected.size || !expected.has(action.actor)) throw Error('Prepared approval set changed.')
  for (const signature of signatures) {
    const signer = await recoverTypedDataAddress({ domain: actionDomain(action), types: ACTION_TYPES, primaryType: 'Action', message: actionMessage(action), signature })
    if (!expected.delete(signer.toLowerCase())) throw Error('Prepared approval signature changed.')
  }
  if (expected.size) throw Error('Prepared approval is missing.')
  return { digest, data: prepared.data as Hex }
}

export function verifyLocalV2Close(prepared: PreparedTransaction, context: LocalV2Context, digest: Hex, operation: 'cancel' | 'reconcile') {
  const data = encodeFunctionData({ abi: V2_COW_ORDER_ABI, functionName: operation === 'cancel' ? 'cancelOrder' : 'reconcile', args: [digest] })
  const envelope = verifyPreparedCall({ ...prepared, data: prepared.data as Hex }, { chainId: context.chainId, to: context.account, data, manifestVersions: new Set([context.manifestVersion]) })
  if (!envelope.ok || prepared.actionHash !== digest) throw Error(envelope.ok ? 'Prepared close digest changed.' : envelope.reason)
  return data
}
