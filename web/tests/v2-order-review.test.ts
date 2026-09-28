import { expect, test } from 'bun:test'
import { encodeFunctionData } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { COW_BALANCE_ERC20, COW_KIND_SELL, V2_COW_ORDER_ABI, actionMessage, contractCowOrder, cowOrderDigest, hashActionIntent } from '@steward/shared'
import type { ActionIntent, CowOrderInput } from '@steward/shared'
import { assertLocalV2Signer, validateLocalV2Order, verifyLocalV2Close, verifyLocalV2Open, type LocalV2Context } from '../src/lib/v2OrderReview'
import { ACTION_TYPES, actionDomain } from '@steward/shared'

const actor = privateKeyToAccount('0x0123456789012345678901234567890123456789012345678901234567890123')
const context: LocalV2Context = { chainId: 31337, account: '0x00000000000000000000000000000000000000aa', parent: actor.address, settlementToken: '0x0000000000000000000000000000000000000001', stockToken: '0x0000000000000000000000000000000000000002', cowSettlement: '0x0000000000000000000000000000000000000003', settlementSymbol: 'USDC', stockSymbol: 'STOCK', settlementDecimals: 6, stockDecimals: 18, policyVersion: '1', securityEpoch: '1', periodEnd: String(Math.floor(Date.now() / 1000) + 3600), maxFeeBps: '100', exceptionSigners: ['0x0000000000000000000000000000000000000004'], exceptionQuorum: 1, manifestVersion: 'local-fixture' }
const validTo = String(Math.floor(Date.now() / 1000) + 300)
const order: CowOrderInput = { sellToken: context.settlementToken, buyToken: context.stockToken, receiver: context.account, sellAmount: '100', buyAmount: '50', validTo, appData: `0x${'44'.repeat(32)}`, feeAmount: '1', kind: COW_KIND_SELL, partiallyFillable: false, sellTokenBalance: COW_BALANCE_ERC20, buyTokenBalance: COW_BALANCE_ERC20 }
const digest = cowOrderDigest(order, context.chainId, context.cowSettlement)
const action: ActionIntent = { actionId: digest, kind: 'BUY', account: context.account, actor: actor.address.toLowerCase() as `0x${string}`, chainId: context.chainId, securityEpoch: '1', policyVersion: '1', nonce: '9', tokenIn: order.sellToken as `0x${string}`, tokenOut: order.buyToken as `0x${string}`, recipient: context.account, amountInRaw: '101', minAmountOutRaw: '50', adapter: context.cowSettlement, routeHash: digest, validAfter: String(Math.floor(Date.now() / 1000) - 5), deadline: validTo, exceptionMask: '0' }

test('browser binds the exact CoW order, typed action and signer before a local send', async () => {
  const signature = await actor.signTypedData({ domain: actionDomain(action), types: ACTION_TYPES, primaryType: 'Action', message: actionMessage(action) })
  const data = encodeFunctionData({ abi: V2_COW_ORDER_ABI, functionName: 'openOrder', args: [contractCowOrder(order), actionMessage(action), [signature]] })
  const prepared = { chainId: context.chainId, to: context.account, value: '0', data, actionHash: hashActionIntent(action), manifestVersion: context.manifestVersion, simulation: { ok: true }, expiresAt: new Date(Date.now() + 30_000).toISOString() }
  expect((await verifyLocalV2Open(prepared, context, order, action, [actor.address])).digest).toBe(digest)
  await expect(verifyLocalV2Open(prepared, context, { ...order, buyAmount: '51' }, action, [actor.address])).rejects.toThrow()
  await expect(verifyLocalV2Open(prepared, context, order, { ...action, nonce: '10' }, [actor.address])).rejects.toThrow()
  await expect(verifyLocalV2Open(prepared, context, order, action, [context.account])).rejects.toThrow()
  const cancelData = encodeFunctionData({ abi: V2_COW_ORDER_ABI, functionName: 'cancelOrder', args: [digest] })
  expect(verifyLocalV2Close({ ...prepared, actionHash: digest, data: cancelData }, context, digest, 'cancel')).toBe(cancelData)
  expect(() => verifyLocalV2Close({ ...prepared, actionHash: digest, data: cancelData }, context, digest, 'reconcile')).toThrow()
})

test('pre-sign review rejects independently changed action, order, context and signer authority', () => {
  const hash = hashActionIntent(action)
  expect(validateLocalV2Order(context, order, action, digest, hash).digest).toBe(digest)
  expect(() => validateLocalV2Order(context, order, { ...action, amountInRaw: '102' }, digest, hashActionIntent({ ...action, amountInRaw: '102' }))).toThrow(/Saved action/)
  expect(() => validateLocalV2Order(context, order, { ...action, actor: context.stockToken }, digest, hash)).toThrow(/identity/)
  expect(() => validateLocalV2Order(context, { ...order, receiver: context.stockToken }, action, digest, hash)).toThrow(/identity|action/)
  expect(() => validateLocalV2Order({ ...context, securityEpoch: '2' }, order, action, digest, hash)).toThrow(/policy/)
  expect(() => validateLocalV2Order({ ...context, policyVersion: '2', periodEnd: '1' }, order, action, digest, hash, true)).not.toThrow()
  expect(() => validateLocalV2Order(context, order, { ...action, exceptionMask: '2' }, digest, hashActionIntent({ ...action, exceptionMask: '2' }))).not.toThrow()
  expect(() => assertLocalV2Signer(context, action, actor.address, actor.address, context.exceptionSigners)).not.toThrow()
  expect(() => assertLocalV2Signer(context, action, context.exceptionSigners[0]!, actor.address, context.exceptionSigners)).toThrow(/not required/)
  expect(() => assertLocalV2Signer(context, { ...action, exceptionMask: '2' }, context.exceptionSigners[0]!, actor.address, context.exceptionSigners)).not.toThrow()
  expect(() => assertLocalV2Signer(context, action, actor.address, context.stockToken, context.exceptionSigners)).toThrow(/changed/)
})
